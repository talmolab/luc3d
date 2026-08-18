// ui/plane-definition.js — "Defining Plane Mode" (View ▸ Define Planes)
//
// Step 1 of re-defining the 3D viewer's origin. The end goal is a translation
// vector + rotation matrix that move the world frame onto a plane the user
// annotates; this module is the ANNOTATION UI and owns nothing about the solve.
//
// The data model lives in `pose/plane-nodes.js` + `pose/plane-data.js`
// (`PlaneNodePool`, `PlaneSkeleton`, `PlaneInstance`, `PlaneModel`); this module
// owns the mode, the panel, drag-and-drop, and the overlay pass. What lives
// here:
//   - `planeState`   — mode flag, THE model (pool + planes + per-view 2D), and
//                      which plane the editor is editing.
//   - Mode enter/exit — shows the "Defining Plane Mode" banner and swaps the
//                      info panel's tab bar for the Define Plane panel.
//   - The Define Plane panel — THREE sibling sections: the global Nodes pool,
//                      the Edit Plane editor (which plane, its name, its member
//                      nodes, its connections), and the Planes list.
//   - Drag-and-drop  — dragging a plane row onto a video view PLACES that plane
//                      there: its nodes get 2D points seeded in a ring around
//                      the drop point.
//   - `drawPlaneOverlays` — draws the placed planes on a view's overlay canvas.
//                      Called by `drawAllOverlays` AFTER `drawFrameOverlays`,
//                      which clears the canvas.
//   - `planeInteractionCallbacks` — hands `ui/interaction.js` the callbacks it
//                      needs to hit-test / drag / select plane nodes.
//
// ## NODES ARE GLOBAL, AND A NODE CAN BE IN SEVERAL PLANES
//
// The pool (`planeState.model.pool`) holds every plane node in the project; a
// plane is an ordered list of node IDs plus optional edges. That is what lets
// two planes MEET along a shared line — the corners on that line are one node
// with one 3D position, so re-solving either plane cannot split the line apart.
//
// The panel's SHAPE is that model made visible, which is why it is three
// SIBLING sections rather than a nodes editor nested inside a plane editor:
//
//   1. Nodes            — the project-wide pool. Name / colour / pin / delete
//                         all act on the NODE, so they apply to every plane
//                         using it. No membership column: a node is not owned
//                         by a plane. `+ Node` mints a POOL node and touches no
//                         plane at all — it neither creates one nor joins one.
//   2. Edit Plane       — WHICH plane (the selector at the top, with a pinned
//                         `+ New Plane` entry), then what THAT plane is made
//                         of: its name, the nodes in it (× removes the
//                         REFERENCE, never the node), an "add an existing node"
//                         dropdown, and its connections.
//   3. Planes           — the list, the drag source, and the actions that run
//                         on the selected plane (Triangulate / Fill / Fit /
//                         Set Origin).
//
// Section 2's `+ Add` dropdown is the headline affordance: picking a node
// another plane already uses is exactly how an intersection is built, and it
// must stay at least as cheap as the checkbox it replaced. It is also the ONLY
// way a node enters a plane — creating a node and putting one in a plane are
// deliberately two separate acts, because a node is not owned by a plane.
//
// SELECTING vs RENAMING are two controls, not one. The top row's `<select>`
// only chooses which plane is edited (and its last entry mints one); the Name
// field in the body is where a plane is renamed. Merging them into one text
// box made "type here" mean both "find" and "rename" depending on state.
//
// ## PINNED (IMMUTABLE) NODES
//
// A node can be pinned: its 3D is frozen and must not be moved by 2D editing,
// triangulation or fitting. Every write path here honours that rather than
// working around it — the 2D drag is refused (with a reason in the status bar),
// triangulation merges the frozen coordinate back in
// (`mergeFrozenPoints3d`), the fit switches to `fitPlaneConstrained` and the
// post-fit 2D write-back skips pinned nodes (rewriting a pinned node's 2D from
// its 3D would destroy the user's annotation AND the anchor-residual readout
// that tells them the pin no longer agrees with what they clicked).
//
// A pinned node with NO 3D (`nodeFreezeState` -> 'frozen-unsolved') is a dead
// end: pinning is what forbids a solve from ever giving it one. The Nodes table
// shows that state in its own colour and the panel carries a visible line
// naming those nodes — not a tooltip, because a tooltip is not read by someone
// who does not already suspect a problem.
//
// EDITING IS GATED ON THE MODE. `isPlaneModeActive()` backs the interaction
// manager's `isPlaneEditMode` callback, so outside Defining Plane Mode a plane
// draws but never takes a click — plane nodes can never compete with pose
// nodes during normal annotation. The same gate rides along in `syncPlanes3D`'s
// `editable` flag, so a plane is inert in BOTH representations outside the mode.
//
// A FITTED plane's corners can also be dragged in the 3D viewport, constrained
// to the plane they were fitted to (`onPlaneNodeDragged3D`). There the 2D
// follows the 3D — the reverse of every other edit path, because a fitted
// corner is defined by the plane and its views are just where it lands. A
// pinned corner is refused there too.
//
// EVERY EDIT HERE MARKS THE PROJECT DIRTY. Plane state is persisted into the
// `.slp` (and the project JSON) by `import-export/plane-metadata.js`, so an
// unsaved rename, re-colour, pin, placement or solve is a real unsaved change
// and the save dot has to say so. The rule is per MUTATION, not per repaint:
// `refreshPlanePanel()` / `syncPlanes3D()` / `redraw()` run for plenty of
// reasons that change nothing on disk (entering the mode, a slider, a hover),
// and calling `markDirty()` from them would leave the dot permanently on.
//
// The node size / edge width / 3D corner size sliders are the deliberate
// exception: they are browser-local display taste, are NOT written to the
// project, and so must not mark it dirty.
//
// The drag payload uses a private MIME type (`PLANE_DRAG_MIME`) and never sets
// `text/plain`. That is load-bearing: `ui/sessions-panes.js` tells dockview to
// accept any `text/plain` drag over the dock and turn it into a new video
// panel, so a plain-text payload here would be swallowed as a bogus view name.

import {
    PlaneModel, PlaneSkeleton, PlaneInstance, PlaneNode, PlaneNodePool,
    seedPlanePoints, planePolygonOrder,
    planeFillOrderPoolIndices, planeFillOrder3d,
    planeNodeIndices, planeNodeNames, planeNodeColors, planeNodeImmutability,
    planeEdgesLocal, planeEdgesPoolIndices, planeCentroid2d,
    points3dForPlane, writePoints3dForPlane, nodeErrorsForPlane,
    nodeFreezeState,
} from '../pose/plane-data.js';
import { hasPoint3d, getPoint3d } from '../pose/pose-data.js';
import { state, interactionManager, viewport3d } from './app-state.js';
import { makeVideoToCanvasTransform } from './overlays.js';
import { setStatus, markDirty } from '../import-export/save-load.js';
// Circular (rendering.js imports `drawPlaneOverlays` from here, and
// triangulation.js imports rendering.js). Safe because every use below is
// inside a function body, so the binding is resolved at call time rather than
// at module evaluation.
import { drawAllOverlays } from './rendering.js';
import {
    triangulatePoints, reprojectPointCamera, cameraDepth,
    fitPlaneToPoints3d, projectPoints3dOntoPlane,
    fitPlaneConstrained, projectPoints3dOntoPlaneConstrained,
    mergeFrozenPoints3d, summarizePlaneTriangulation, planesInvalidatedByFit,
} from '../pose/triangulation.js';
// Circular (origin-definition imports `planeState` / `syncPlanes3D` back).
// Same rule as the rendering.js cycle above: call-time use only.
import {
    enterOriginMode, exitOriginMode, isOriginModeActive, attachOriginCallbacks,
    setupOriginDefinition, renderOriginResult, fittedPlanes,
} from './origin-definition.js';

// Re-exported so callers (and tests) can reach the model through the feature
// module without knowing it was split out.
export {
    PlaneModel, PlaneSkeleton, PlaneInstance, PlaneNode, PlaneNodePool,
    seedPlanePoints, planePolygonOrder, points3dForPlane, nodeFreezeState,
};

// Private drag MIME. See the module note above — must NOT be `text/plain`.
export const PLANE_DRAG_MIME = 'application/x-lucid-plane-skeleton';

export const planeState = {
    /** @type {boolean} True while Defining Plane Mode is active. */
    active: false,
    /**
     * @type {PlaneModel} The whole plane annotation state: the global node
     * pool, the planes, and the per-view 2D. Project-scoped (app-session
     * memory) except the 2D, which is re-attached per session by
     * `planeModel()`.
     */
    model: new PlaneModel(),
    /** @type {number|null} `PlaneSkeleton.id` the editor is editing. */
    selectedPlaneId: null,
    /**
     * @type {number} Node radius in canvas px, SHARED by every plane. One
     * value rather than per-plane: these are reference geometry you size
     * once for legibility against your video, not per-plane styling.
     */
    nodeSize: 5,
    /** @type {number} Edge stroke width in canvas px, shared by every plane. */
    edgeWidth: 2,
    /**
     * @type {number} Plane-corner sphere size in the 3D scene, shared by every
     * plane. Separate from `nodeSize` (canvas px) because the two live in
     * unrelated units, and separate from the viewport's `skeletonNodeSize` so
     * sizing plane corners for legibility never resizes pose nodes.
     */
    nodeSize3d: 4,
    /** @type {Set<number>} Plane ids whose placement list is expanded. */
    expanded: new Set(),
};

/**
 * The plane model, with its 2D bound to the ACTIVE session.
 *
 * Planes and nodes are project-scoped, but a `PlaneInstance` is 2D on one
 * session's views, so the placements map is stored on the `Session` and adopted
 * here whenever the active session changes. `attachPlacements` re-syncs every
 * instance to the pool and prunes placement flags for planes that no longer
 * exist — the identity check keeps that to once per session switch rather than
 * once per call.
 *
 * @returns {PlaneModel}
 */
export function planeModel() {
    var session = state.session;
    if (session) {
        if (!session.planePlacements) session.planePlacements = new Map();
        if (planeState.model.placements !== session.planePlacements) {
            planeState.model.attachPlacements(session.planePlacements);
        }
    }
    return planeState.model;
}

/** The global node pool. @returns {PlaneNodePool} */
export function planePool() {
    return planeModel().pool;
}

/** Every plane in the project, in creation order. @returns {PlaneSkeleton[]} */
export function getPlanes() {
    return planeModel().planes;
}

/** The plane with this id, or null. @param {number} id @returns {PlaneSkeleton|null} */
export function getPlane(id) {
    return planeModel().getPlane(id);
}

/** The plane the editor is currently editing, or null. @returns {PlaneSkeleton|null} */
export function getSelectedPlane() {
    return planeState.selectedPlaneId == null ? null : getPlane(planeState.selectedPlaneId);
}

/** Create a plane, select it for editing, and return it. @returns {PlaneSkeleton} */
export function createPlane(name) {
    var plane = planeModel().createPlane(name);
    planeState.selectedPlaneId = plane.id;
    markDirty();
    return plane;
}

/**
 * Delete a plane. Its NODES survive — every one of them.
 *
 * Nodes are plane-independent now, so they outlive the planes that referenced
 * them: a node left in no plane is an ordinary pool member that simply is not
 * drawn on any view, and auto-pruning it would throw away a pinned coordinate
 * or a carefully placed 2D point as a side effect of tidying up. The Nodes
 * table is the one place a node is destroyed, and it says so.
 *
 * @param {number} id @returns {boolean}
 */
export function deletePlane(id) {
    var model = planeModel();
    var plane = model.getPlane(id);
    if (!plane) return false;
    var kept = plane.nodeIds.length;
    var res = model.deletePlane(plane);
    if (!res.removed) return false;
    if (kept) {
        setStatus('Deleted plane "' + plane.name + '" — its ' + kept +
            ' node(s) are kept in the Nodes table; delete them there if you ' +
            'no longer want them');
    }
    if (planeState.selectedPlaneId === id) {
        planeState.selectedPlaneId = model.planes.length ? model.planes[0].id : null;
    }
    planeState.expanded.delete(id);
    clearSelectionIfGone();
    markDirty();
    syncPlanes3D();
    return true;
}

/**
 * The pool's 3D in one plane's node order — what `ui/origin-definition.js` and
 * the 3D payload read. Materialized on demand; the pool is the source of truth.
 * @param {PlaneSkeleton} plane @returns {Float64Array}
 */
export function planePoints3d(plane) {
    return points3dForPlane(plane, planePool());
}

/** Name of the node at position `idx` in a plane's own order. @returns {string} */
export function planeNodeNameAt(plane, idx) {
    var node = plane && plane.nodeIds[idx] != null
        ? planePool().getNode(plane.nodeIds[idx]) : null;
    return node ? node.name : ('node ' + idx);
}

/** Does any node of this plane have a 3D position? @returns {boolean} */
export function planeHasAny3d(plane) {
    if (!plane) return false;
    var pool = planePool();
    for (var i = 0; i < plane.nodeIds.length; i++) {
        var node = pool.getNode(plane.nodeIds[i]);
        if (node && node.hasPoint3d()) return true;
    }
    return false;
}

/**
 * Per-node immutability of a plane, in the plane's own order — the mask shape
 * `fitPlaneConstrained` / `mergeFrozenPoints3d` /
 * `projectPoints3dOntoPlaneConstrained` all take.
 * @param {PlaneSkeleton} plane @returns {boolean[]}
 */
function planeImmutableMask(plane) {
    var pool = planePool();
    return plane.nodeIds.map(function (id) {
        var node = pool.getNode(id);
        return !!(node && node.immutable);
    });
}

// ============================================
// Placements (per session, per view, frame-independent)
// ============================================

/**
 * The active session's `PlaneInstance` for `viewName`, or null. One instance
 * per VIEW (not per view+plane): its index space is the pool's node order, so a
 * node shared by two planes has one 2D point per view for the same reason it
 * has one 3D point.
 * @param {string} viewName @returns {PlaneInstance|null}
 */
export function getPlaneInstance(viewName) {
    return planeModel().getInstance(viewName);
}

/** `[instance]` or `[]` — the shape `ui/interaction.js` iterates. */
export function getPlaneInstances(viewName) {
    var inst = getPlaneInstance(viewName);
    return inst ? [inst] : [];
}

/** Planes placed on a view, in creation order. @returns {PlaneSkeleton[]} */
export function placedPlanesOn(viewName) {
    return planeModel().placedPlanes(viewName);
}

/** Views a plane is placed on. @returns {string[]} */
export function placedViewsOf(plane) {
    return planeModel().placedViews(plane);
}

/**
 * Place `plane` on `viewName` centred at (cx, cy) in video pixels.
 *
 * ONE PLACEMENT PER VIEW PER PLANE: a second drop of the same plane on the same
 * view is refused rather than re-seeding, so carefully positioned nodes can't be
 * destroyed by a stray drag. Un-place it first to redo it.
 *
 * @returns {PlaneInstance|null} null if refused or the view is unavailable.
 */
export function placePlaneOnView(plane, viewName, cx, cy) {
    var model = planeModel();
    if (!plane || !state.session) return null;
    var view = findView(viewName);
    if (!view) return null;
    if (model.isPlanePlaced(plane, viewName)) return null;
    model.placePlane(plane, viewName, cx, cy, view.videoWidth || 0, view.videoHeight || 0);
    markDirty();
    return model.getInstance(viewName);
}

/**
 * Un-place a plane from a view. The 2D points are DELIBERATELY kept (see
 * `PlaneModel.unplacePlane`) — visibility is derived from the placed set, so
 * re-placing restores exactly what the user positioned.
 * @returns {boolean}
 */
export function unplacePlaneFromView(plane, viewName) {
    var removed = planeModel().unplacePlane(plane, viewName);
    if (removed) {
        markDirty();
        clearSelectionIfGone();
        syncPlanes3D();
    }
    return removed;
}

/**
 * Drop the interaction manager's plane selection if the selected instance is no
 * longer showing anything — a dangling selection would keep a plane highlighted
 * and reachable by keyboard after its last placement went away.
 */
function clearSelectionIfGone() {
    if (!interactionManager || !interactionManager.selectedPlane) return;
    var inst = interactionManager.selectedPlane;
    var model = planeModel();
    if (model.getInstance(inst.viewName) !== inst ||
        model.placedPlanes(inst.viewName).length === 0) {
        interactionManager.selectPlane(null, -1);
    }
}

function findView(viewName) {
    for (var i = 0; i < state.views.length; i++) {
        if (state.views[i].name === viewName) return state.views[i];
    }
    return null;
}

/**
 * `[videoW, videoH]` per view — the clamp bounds `PlaneModel` needs when it
 * seeds a node onto a view it has never been positioned on.
 */
function viewBounds(viewName) {
    var view = findView(viewName);
    return view ? [view.videoWidth || 0, view.videoHeight || 0] : [0, 0];
}

// ============================================
// Triangulation
// ============================================

/**
 * Triangulate a plane across every view it is placed on.
 *
 * This is the first half of the origin pipeline: it turns the 2D annotation
 * into 3D corner positions, which a later step fits a plane to and converts
 * into a translation + rotation.
 *
 * Follows `triangulateAndReproject`'s contract exactly on the two points that
 * matter for correctness: observations are UNDISTORTED before the linear DLT
 * (which is only valid in ideal pinhole coordinates), and error is measured in
 * each camera's NATIVE pixel space against the raw annotation — the space the
 * user actually clicked in. Nodes toggled off with right-click are excluded,
 * per view, which is the whole point of that gesture.
 *
 * PINNED nodes keep their stored 3D: the DLT result for them is discarded by
 * `mergeFrozenPoints3d` and the write-back (`writePoints3dForPlane` without
 * `force`) refuses them anyway. Their reprojection error is still measured —
 * it is an OUT-OF-SAMPLE residual saying "your pinned anchor no longer agrees
 * with where you clicked", which is exactly what a pin is worth checking for —
 * and reported separately (`summarizePlaneTriangulation`).
 *
 * DLT only (no BA option yet): a plane is 3-8 hand-placed corners, so the
 * linear solve is instant and the non-linear refinement has little to work
 * with. Revisit if the reprojection errors turn out to warrant it.
 *
 * @param {PlaneSkeleton} plane
 * @returns {{ok:boolean, reason?:string, views?:string[], nNodes?:number,
 *             meanError?:number|null, nAnchors?:number,
 *             anchorMeanError?:number|null}} `ok:false` carries a
 *   human-readable `reason` that the caller shows in the status bar.
 */
export function triangulatePlane(plane) {
    if (!plane) return { ok: false, reason: 'No plane selected' };
    var model = planeModel();
    var pool = model.pool;
    var session = state.session;
    if (!session || !session.cameras || session.cameras.length < 2) {
        return { ok: false, reason: 'Load calibration for 2+ cameras first' };
    }
    if (!plane.nodeIds.length) {
        return { ok: false, reason: 'Plane "' + plane.name + '" has no nodes' };
    }

    // The views this plane is actually placed on, in camera order.
    var contributors = [];
    for (var c = 0; c < session.cameras.length; c++) {
        var cam = session.cameras[c];
        if (!model.isPlanePlaced(plane, cam.name)) continue;
        var inst = model.getInstance(cam.name);
        if (inst) contributors.push({ cam: cam, inst: inst });
    }
    if (contributors.length < 2) {
        return {
            ok: false,
            reason: '"' + plane.name + '" is placed on ' + contributors.length +
                ' view' + (contributors.length === 1 ? '' : 's') + ' — needs 2+',
        };
    }

    var projMatrices = contributors.map(function (v) { return v.cam.projectionMatrix; });
    // The 2D is indexed by POOL order; everything below is in PLANE order, so
    // this is the one translation between the two index spaces.
    var poolIdx = planeNodeIndices(plane, pool);
    var nNodes = poolIdx.length;

    // allObs[k][c] undistorted (for DLT); allRaw[k][c] native (for error).
    var allObs = [];
    var allRaw = [];
    for (var k = 0; k < nNodes; k++) {
        var obs = [];
        var raw = [];
        for (var vi = 0; vi < contributors.length; vi++) {
            var p = contributors[vi].inst;
            var camv = contributors[vi].cam;
            var pi = poolIdx[k];
            // A DERIVED point is this solve's own previous output reprojected
            // into a view the user never annotated. Feeding it back adds no
            // information and pulls the reported error toward zero, so it is
            // excluded exactly like a nulled one.
            if (pi >= 0 && p.hasPoint(pi) && !p.isNodeNulled(pi) && !p.isNodeDerived(pi)) {
                var r = p.getPoint(pi);
                raw.push(r);
                obs.push(camv.undistortPoint ? camv.undistortPoint(r) : r);
            } else {
                obs.push(null);
                raw.push(null);
            }
        }
        allObs.push(obs);
        allRaw.push(raw);
    }

    // Views carrying at least one HAND-PLACED observation. Placement alone is
    // no longer the same question: once triangulation reprojects a plane into
    // the views it was not placed on, those views ARE placed but contribute
    // nothing, so gating on `contributors.length` would let a plane annotated
    // on a single view look like a 2-view solve and return a confident answer
    // built from one ray.
    var usableViews = [];
    for (var uv = 0; uv < contributors.length; uv++) {
        for (var un = 0; un < nNodes; un++) {
            if (allRaw[un][uv]) { usableViews.push(contributors[uv].cam.name); break; }
        }
    }
    if (usableViews.length < 2) {
        return {
            ok: false,
            reason: '"' + plane.name + '" has hand-placed corners on ' +
                (usableViews.length ? 'only 1 view (' + usableViews[0] + ')' : 'no view') +
                ' — reprojected corners are not evidence, so place it on another view',
        };
    }

    var mask = planeImmutableMask(plane);
    // Frozen coordinates come back in bit-identically; a frozen node whose DLT
    // happened to succeed must NOT adopt that result.
    var points3d = mergeFrozenPoints3d(
        triangulatePoints(allObs, projMatrices), points3dForPlane(plane, pool), mask);

    // Per-node reprojection error, averaged over the views that contributed.
    var nodeErrors = [];
    for (var n2 = 0; n2 < nNodes; n2++) {
        if (!hasPoint3d(points3d, n2)) { nodeErrors.push(null); continue; }
        var pt = getPoint3d(points3d, n2);
        var sum = 0, cnt = 0;
        for (var v2 = 0; v2 < contributors.length; v2++) {
            if (!allRaw[n2][v2]) continue;
            var rp = reprojectPointCamera(pt, contributors[v2].cam);
            if (!rp) continue;
            var dx = rp[0] - allRaw[n2][v2][0];
            var dy = rp[1] - allRaw[n2][v2][1];
            sum += Math.sqrt(dx * dx + dy * dy);
            cnt++;
        }
        nodeErrors.push(cnt > 0 ? sum / cnt : null);
    }

    var summary = summarizePlaneTriangulation(points3d, nodeErrors, mask);
    if (summary.nNodes === 0 && summary.nAnchors === 0) {
        plane.clearTriangulation();
        return {
            ok: false,
            reason: 'No node of "' + plane.name + '" is placed (and enabled) in 2+ views',
        };
    }

    // Publish: 3D onto the NODES (pinned ones are skipped by the writer), the
    // per-node error onto the node too — one point has one error however many
    // planes share it.
    writePoints3dForPlane(plane, pool, points3d);
    for (var w = 0; w < nNodes; w++) {
        var node = pool.getNode(plane.nodeIds[w]);
        if (node && !node.immutable) node.error = nodeErrors[w];
        else if (node) node.error = nodeErrors[w] != null ? nodeErrors[w] : node.error;
    }

    // Only the views that actually contributed, so the stored summary (and
    // `refreshTriangulationErrors`, which re-derives from it) never averages in
    // a view whose residual is zero by construction.
    var viewNames = usableViews;
    var reprojected = reprojectPlaneIntoUnplacedViews(plane);
    plane.triangulation = {
        views: viewNames,
        nNodes: summary.nNodes,
        meanError: summary.meanError,
        nAnchors: summary.nAnchors,
        anchorMeanError: summary.anchorMeanError,
    };
    return {
        ok: true,
        views: viewNames,
        nNodes: summary.nNodes,
        meanError: summary.meanError,
        nAnchors: summary.nAnchors,
        anchorMeanError: summary.anchorMeanError,
        reprojectedViews: reprojected.views,
        reprojectedNodes: reprojected.nodes,
        behindViews: reprojected.behindViews,
    };
}

/**
 * Reproject a plane's solved 3D into every view it is NOT placed on, write the
 * result into that view's `PlaneInstance`, and place the plane there.
 *
 * Why into the PlaneInstance and not a separate reprojection overlay: a plane is
 * reference geometry the user is trying to get RIGHT, so the useful thing is not
 * just seeing where it lands in the other views but being able to grab a corner
 * there and correct it. A read-only marker would show the disagreement and offer
 * no way to act on it. So these become real plane points — draggable, and the
 * moment one is dragged it stops being derived and starts being evidence
 * (`onPlaneChanged`).
 *
 * Three things this deliberately refuses to do:
 *   - **Claim to be evidence.** Each written point is flagged
 *     `derived` on the instance and excluded from the next solve and from the
 *     reprojection-error average. It is the current 3D projected, so its
 *     residual is zero by construction; counting it would make the error
 *     readout improve every time the button is pressed.
 *   - **Write a mirrored ghost.** A point BEHIND a camera still divides through
 *     to a finite, plausible pixel coordinate (`reprojectPoint` does not check
 *     the sign of `w`), so every node is gated on `cameraDepth > 0`. A view that
 *     ends up with nothing in front of it is left alone entirely, not placed.
 *   - **Touch a view the user placed.** Placed views hold the user's own
 *     annotation; overwriting it with the model's opinion of it is precisely
 *     what `applyPlaneFit` refuses to do for pinned nodes, for the same reason.
 *     The one exception is a point that is ITSELF derived: those are refreshed
 *     wherever they are, because a reprojection left over from a solve two edits
 *     ago is worse than none — it reads as current.
 *
 * Nodes with no 3D contribute nothing. Off-frame reprojections ARE written when
 * the point is in front of the camera — the plane may legitimately extend past
 * the frame edge, and clamping would fake a corner position.
 *
 * @param {PlaneSkeleton} plane
 * @returns {{views:string[], refreshedViews:string[], nodes:number,
 *            behindViews:string[]}} `views` = views written to and newly placed;
 *   `refreshedViews` = already-placed views whose derived points were brought up
 *   to date; `behindViews` = views skipped because no corner is in front of that
 *   camera.
 */
export function reprojectPlaneIntoUnplacedViews(plane) {
    var out = { views: [], refreshedViews: [], nodes: 0, behindViews: [] };
    var session = state.session;
    if (!plane || !session || !session.cameras) return out;
    var model = planeModel();
    var pool = model.pool;
    var points3d = points3dForPlane(plane, pool);

    for (var c = 0; c < session.cameras.length; c++) {
        var cam = session.cameras[c];
        // Keyed by camera name, like every other plane path — a view IS a
        // camera here. A camera with no view on screen would be given a
        // placement nobody can see, so it is skipped.
        if (!viewByName(cam.name)) continue;
        var placed = model.isPlanePlaced(plane, cam.name);
        var existing = model.getInstance(cam.name);
        // A PLACED view holds the user's own annotation and is never touched —
        // except for points that are themselves derived, which must be brought
        // up to date or they are a stale reprojection of a solve two edits ago,
        // displayed as if current.
        if (placed && (!existing || !existing.derivedNodes.size)) continue;

        var writes = [];
        var anyBehind = false;
        for (var k = 0; k < plane.nodeIds.length; k++) {
            if (!hasPoint3d(points3d, k)) continue;
            var pi = pool.indexOf(plane.nodeIds[k]);
            if (pi < 0) continue;
            if (placed && !existing.isNodeDerived(pi)) continue;
            var xyz = getPoint3d(points3d, k);
            var w = cameraDepth(xyz, cam);
            if (!(w > 0) || !isFinite(w)) { anyBehind = true; continue; }
            var uv = reprojectPointCamera(xyz, cam);
            if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) continue;
            writes.push([pi, uv[0], uv[1]]);
        }
        if (!writes.length) {
            if (anyBehind && !placed) out.behindViews.push(cam.name);
            continue;
        }

        var inst = model.ensureInstance(cam.name);
        for (var wi = 0; wi < writes.length; wi++) {
            inst.setPoint(writes[wi][0], writes[wi][1], writes[wi][2]);
            inst.setNodeDerived(writes[wi][0], true);
        }
        inst.modified = true;
        out.nodes += writes.length;
        if (placed) {
            out.refreshedViews.push(cam.name);
        } else {
            inst.placedPlanes.add(plane.id);
            out.views.push(cam.name);
        }
    }
    return out;
}

/** The `state.views` entry named `name`, or null. @returns {Object|null} */
function viewByName(name) {
    var views = state.views || [];
    for (var i = 0; i < views.length; i++) {
        if (views[i].name === name) return views[i];
    }
    return null;
}

/** Triangulate + push to the 3D viewer + report + refresh the panel. */
function triangulatePlaneAndReport(plane) {
    var res = triangulatePlane(plane);
    if (!res.ok) {
        setStatus(res.reason, 'warning');
    } else {
        // Expand the row so the freshly computed 3D is visible, not silent.
        planeState.expanded.add(plane.id);
        setStatus('Triangulated "' + plane.name + '": ' + res.nNodes + '/' +
            plane.nodeIds.length + ' nodes from ' + res.views.length + ' views' +
            (res.nAnchors ? ' (' + res.nAnchors + ' pinned, kept)' : '') +
            (res.meanError != null ? ' — mean error ' + res.meanError.toFixed(2) + ' px' : '') +
            // Say where the plane just appeared and that those corners are the
            // model's, not evidence — they are draggable, and dragging one is
            // what turns it into an observation.
            (res.reprojectedViews && res.reprojectedViews.length
                ? '; reprojected onto ' + res.reprojectedViews.join(', ') +
                  ' (drag a corner there to make it count)'
                : '') +
            (res.behindViews && res.behindViews.length
                ? '; behind ' + res.behindViews.join(', ')
                : ''),
            'success');
    }
    // A solve writes node 3D and, via the reprojection pass, 2D on the views
    // the plane was not placed on. A REFUSED solve wrote neither, so it does
    // not mark the project dirty.
    if (res.ok) markDirty();
    syncPlanes3D();
    refreshPlanePanel();
    // The 2D overlays too, not just the 3D: triangulation now WRITES 2D — it
    // reprojects the plane into the views it was not placed on — so without
    // this the new placement is real but invisible until some unrelated event
    // happens to redraw.
    redraw();
    return res;
}

// ============================================
// Fitting a plane of best fit
// ============================================

/**
 * Work out what fitting `plane` WOULD do, without changing anything.
 *
 * Split from `applyPlaneFit` because two of the outcomes need the user before
 * anything is written: a blocking error (the pinned nodes make the fit
 * impossible) must mutate nothing at all, and the `mutable_far_from_plane`
 * warning must be CONFIRMED — the fit is valid there, only its consequence
 * (dragging a corner metres onto the plane its pinned neighbours define) is
 * drastic.
 *
 * With NO pinned node this goes through `fitPlaneToPoints3d` unchanged. The
 * constrained solver is deliberately not used for the free case: it would move
 * floats for no benefit, and it returns `not_constrained` there precisely so a
 * caller cannot do it by accident.
 *
 * @param {PlaneSkeleton} plane
 * @returns {{ok:boolean, code:string, message:string, warnings:Array,
 *            fit?:Object, flattened?:Float64Array, before?:Float64Array,
 *            mask?:boolean[], movedNodeIds?:number[], stalePlaneIds?:number[],
 *            metrics?:Object}}
 */
export function planPlaneFit(plane) {
    if (!plane) return { ok: false, code: 'no_plane', message: 'No plane selected', warnings: [] };
    var model = planeModel();
    var pool = model.pool;

    // Fit needs 3D. Solve it first rather than making the user click twice.
    if (!planeHasAny3d(plane)) {
        var tri = triangulatePlane(plane);
        if (!tri.ok) return { ok: false, code: 'no_3d', message: tri.reason, warnings: [] };
    }

    var before = points3dForPlane(plane, pool);
    var mask = planeImmutableMask(plane);
    var anyFrozen = false;
    for (var i = 0; i < mask.length; i++) if (mask[i]) { anyFrozen = true; break; }

    var fit = null, flattened = null, warnings = [], message = '', metrics = null;
    if (!anyFrozen) {
        fit = fitPlaneToPoints3d(before);
        if (!fit) {
            return {
                ok: false, code: 'insufficient_points', warnings: [],
                message: '"' + plane.name +
                    '" needs 3+ non-collinear triangulated nodes to fit a plane',
            };
        }
        flattened = projectPoints3dOntoPlane(before, fit);
    } else {
        var res = fitPlaneConstrained(before, {
            immutable: mask,
            nodeNames: planeNodeNames(plane, pool),
            planeName: plane.name,
            previousNormal: plane.planeFit ? plane.planeFit.normal : null,
            unit: 'mm',
        });
        if (!res.ok) {
            return {
                ok: false, code: res.code, message: res.message,
                warnings: res.warnings || [], metrics: res.metrics,
            };
        }
        fit = res.plane;
        warnings = res.warnings || [];
        message = res.message;
        metrics = res.metrics;
        flattened = projectPoints3dOntoPlaneConstrained(before, fit, mask);
    }

    // Which nodes this fit would actually MOVE. `Object.is` rather than a
    // tolerance: the constrained projection copies immutable coordinates
    // verbatim and leaves missing ones missing (NaN, which `Object.is` treats
    // as equal to itself), so the diff is exact by construction.
    var movedNodeIds = [];
    for (var k = 0; k < plane.nodeIds.length; k++) {
        var o = k * 3;
        if (!Object.is(before[o], flattened[o]) ||
            !Object.is(before[o + 1], flattened[o + 1]) ||
            !Object.is(before[o + 2], flattened[o + 2])) {
            movedNodeIds.push(plane.nodeIds[k]);
        }
    }
    // A node this plane shares with another one moving is ordinary work, not an
    // error — but the OTHER plane's stored fit was derived from where that node
    // used to be, so it is now stale and must not be left looking valid.
    var stalePlaneIds = planesInvalidatedByFit(movedNodeIds, model.planes, plane.id);

    return {
        ok: true, code: 'ok', message: message, warnings: warnings, metrics: metrics,
        fit: fit, flattened: flattened, before: before, mask: mask,
        movedNodeIds: movedNodeIds, stalePlaneIds: stalePlaneIds,
    };
}

/**
 * Commit a plan from {@link planPlaneFit}: flatten the corners onto the fitted
 * plane and push the correction out to BOTH representations — the 3D viewer and
 * every 2D view the plane is placed on.
 *
 * Triangulated corners are never exactly coplanar (each carries independent
 * reprojection error), but the thing we ultimately want a translation +
 * rotation from IS a plane — so the fit is what turns a cloud of four
 * nearly-coplanar points into an actual plane, and writing the flattened points
 * back is what makes the annotation agree with it.
 *
 * The 2D write-back reprojects through `reprojectPointCamera`, which applies
 * lens distortion — annotations live in the camera's NATIVE pixel space, so the
 * ideal-pinhole `Camera.project` would drift outward near the frame edges.
 * PINNED nodes are skipped entirely: their 3D did not move, and rewriting their
 * 2D from it would overwrite the user's annotation with the model's opinion of
 * it and destroy the anchor-residual diagnostic in one go.
 *
 * Nodes toggled off in a view still get their 2D updated there: "off" means
 * "don't use this observation in the solve", not "this corner isn't on the
 * plane", and leaving it stale would distort the drawn polygon. The off flags
 * themselves are preserved.
 *
 * @param {PlaneSkeleton} plane
 * @param {Object} plan - From `planPlaneFit`.
 * @returns {{ok:boolean, rms:number, nPoints:number, movedPx:number,
 *            skippedIds:number[], stalePlaneNames:string[]}}
 */
export function applyPlaneFit(plane, plan) {
    var model = planeModel();
    var pool = model.pool;
    var flattened = plan.flattened;

    var written = writePoints3dForPlane(plane, pool, flattened);
    plane.planeFit = {
        centroid: plan.fit.centroid,
        normal: plan.fit.normal,
        rms: plan.fit.rms,
        nPoints: plan.fit.nPoints,
        constrained: !!plan.fit.constrained,
    };

    // Push the corrected corners back into every 2D view this plane is on.
    var session = state.session;
    var movedSum = 0, movedCount = 0;
    if (session && session.cameras) {
        for (var c = 0; c < session.cameras.length; c++) {
            var cam = session.cameras[c];
            if (!model.isPlanePlaced(plane, cam.name)) continue;
            var inst = model.getInstance(cam.name);
            if (!inst) continue;
            for (var k = 0; k < plane.nodeIds.length; k++) {
                if (plan.mask[k]) continue;                 // pinned: leave the annotation alone
                if (!hasPoint3d(flattened, k)) continue;
                var pi = pool.indexOf(plane.nodeIds[k]);
                if (pi < 0 || pi >= inst.numNodes) continue;
                var uv = reprojectPointCamera(getPoint3d(flattened, k), cam);
                if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) continue;
                // `movedPx` answers "how far did the fit move YOUR
                // annotations" — a derived point is the model's own
                // reprojection, so its movement is not that. Still rewritten
                // below, so it keeps agreeing with the 3D.
                if (inst.hasPoint(pi) && !inst.isNodeDerived(pi)) {
                    var dx = uv[0] - inst.getX(pi);
                    var dy = uv[1] - inst.getY(pi);
                    movedSum += Math.sqrt(dx * dx + dy * dy);
                    movedCount++;
                }
                inst.setPoint(pi, uv[0], uv[1]);
            }
            inst.modified = true;
        }
    }

    // A shared node that moved silently breaks the OTHER plane's fit.
    var staleNames = [];
    for (var s = 0; s < plan.stalePlaneIds.length; s++) {
        var other = model.getPlane(plan.stalePlaneIds[s]);
        if (!other || !other.planeFit) continue;
        other.planeFit = null;
        staleNames.push(other.name);
    }

    // The 3D is now the FITTED plane and the 2D matches it, so the stored
    // triangulation summary is no longer the whole story — re-derive the
    // reprojection errors against the flattened points so the panel reports
    // what is actually on screen.
    refreshTriangulationErrors(plane);

    return {
        ok: true,
        rms: plan.fit.rms,
        nPoints: plan.fit.nPoints,
        movedPx: movedCount > 0 ? movedSum / movedCount : 0,
        skippedIds: written.skippedIds,
        stalePlaneNames: staleNames,
    };
}

/**
 * Plan + commit in one call. `opts.confirmed` skips the confirmation the
 * `mutable_far_from_plane` warning would otherwise demand — the interactive
 * path (`fitPlaneAndReport`) asks first; a caller that has already decided
 * (or a test) passes it.
 *
 * @param {PlaneSkeleton} plane
 * @param {{confirmed?:boolean}} [opts]
 * @returns {{ok:boolean, code?:string, reason?:string, needsConfirm?:boolean,
 *            rms?:number, nPoints?:number, movedPx?:number,
 *            skippedIds?:number[], stalePlaneNames?:string[], plan?:Object}}
 */
export function fitPlane(plane, opts) {
    var plan = planPlaneFit(plane);
    if (!plan.ok) return { ok: false, code: plan.code, reason: plan.message, plan: plan };
    var warn = findWarning(plan.warnings, 'mutable_far_from_plane');
    if (warn && !(opts && opts.confirmed)) {
        return { ok: false, code: 'needs_confirm', needsConfirm: true,
                 reason: warn.message, plan: plan };
    }
    var res = applyPlaneFit(plane, plan);
    res.plan = plan;
    return res;
}

/** The warning with this `code`, or null. @private */
function findWarning(warnings, code) {
    if (!warnings) return null;
    for (var i = 0; i < warnings.length; i++) {
        if (warnings[i] && warnings[i].code === code) return warnings[i];
    }
    return null;
}

/**
 * Recompute a plane's per-node + mean reprojection error against the CURRENT
 * node 3D and the CURRENT 2D. Used after a fit, where the 3D moved but the view
 * set did not.
 */
function refreshTriangulationErrors(plane) {
    var t = plane.triangulation;
    var session = state.session;
    if (!t || !session || !session.cameras) return;
    var model = planeModel();
    var pool = model.pool;
    var points3d = points3dForPlane(plane, pool);

    var contributors = [];
    for (var c = 0; c < session.cameras.length; c++) {
        var cam = session.cameras[c];
        if (t.views.indexOf(cam.name) < 0) continue;
        var inst = model.getInstance(cam.name);
        if (inst) contributors.push({ cam: cam, inst: inst });
    }

    var mask = planeImmutableMask(plane);
    var nodeErrors = [];
    for (var k = 0; k < plane.nodeIds.length; k++) {
        var node = pool.getNode(plane.nodeIds[k]);
        if (!hasPoint3d(points3d, k)) { nodeErrors.push(null); if (node) node.error = null; continue; }
        var pt = getPoint3d(points3d, k);
        var pi = pool.indexOf(plane.nodeIds[k]);
        var s = 0, n = 0;
        for (var v = 0; v < contributors.length; v++) {
            var p = contributors[v].inst;
            if (pi < 0 || !p.hasPoint(pi) || p.isNodeNulled(pi)) continue;
            if (p.isNodeDerived(pi)) continue;   // its residual is 0 by construction
            var rp = reprojectPointCamera(pt, contributors[v].cam);
            if (!rp) continue;
            var dx = rp[0] - p.getX(pi);
            var dy = rp[1] - p.getY(pi);
            s += Math.sqrt(dx * dx + dy * dy);
            n++;
        }
        var e = n > 0 ? s / n : null;
        nodeErrors.push(e);
        if (node) node.error = e;
    }
    var summary = summarizePlaneTriangulation(points3d, nodeErrors, mask);
    t.nNodes = summary.nNodes;
    t.meanError = summary.meanError;
    t.nAnchors = summary.nAnchors;
    t.anchorMeanError = summary.anchorMeanError;
}

/**
 * Fit + report + refresh both representations.
 *
 * Dispatches on the result CODE, never on the message text: the constrained
 * solver's messages name nodes and distances and are meant for the user, so
 * matching on them would break the moment one is reworded.
 */
function fitPlaneAndReport(plane) {
    var res = fitPlane(plane);
    if (res.needsConfirm) {
        showPlaneDialog({
            title: 'Flattening will move points a long way',
            message: res.reason,
            confirmLabel: 'Fit anyway',
            onConfirm: function () {
                var done = applyPlaneFit(plane, res.plan);
                reportFit(plane, done);
                markDirty();
                syncPlanes3D();
                refreshPlanePanel();
                redraw();
            },
        });
        return res;
    }
    if (!res.ok) {
        // A blocking constrained-fit error is a paragraph explaining which
        // pinned nodes make the fit impossible and what to do about it — too
        // much for the status bar alone to carry.
        if (isBlockingFitCode(res.code)) {
            showPlaneDialog({ title: 'Cannot fit this plane', message: res.reason });
        }
        setStatus(res.reason, 'warning');
    } else {
        planeState.expanded.add(plane.id);
        reportFit(plane, res);
        markDirty();
    }
    syncPlanes3D();
    refreshPlanePanel();
    redraw();
    return res;
}

/** Error codes from `fitPlaneConstrained` that BLOCK the fit. @private */
const BLOCKING_FIT_CODES = [
    'no_anchor_3d', 'anchors_collinear', 'anchors_noncoplanar', 'underdetermined',
];

function isBlockingFitCode(code) {
    return BLOCKING_FIT_CODES.indexOf(code) >= 0;
}

/** Status line for a successful fit, including what it invalidated. @private */
function reportFit(plane, res) {
    planeState.expanded.add(plane.id);
    var msg = 'Fitted plane to "' + plane.name + '": ' + res.nPoints +
        ' points were ' + res.rms.toFixed(2) + ' mm RMS off-plane; corners moved ' +
        res.movedPx.toFixed(1) + ' px in 2D';
    if (res.skippedIds && res.skippedIds.length) {
        msg += ' — ' + res.skippedIds.length + ' pinned node(s) held fixed';
    }
    if (res.stalePlaneNames && res.stalePlaneNames.length) {
        msg += '. It moved shared nodes, so the fit of ' +
            res.stalePlaneNames.map(function (n) { return '"' + n + '"'; }).join(', ') +
            ' is now stale — re-fit ' +
            (res.stalePlaneNames.length === 1 ? 'it' : 'them');
        setStatus(msg, 'warning');
        return;
    }
    setStatus(msg, 'success');
}

// ============================================
// The plane dialog (blocking error / confirmation)
// ============================================

/**
 * A small modal for the outcomes the status bar cannot carry: a blocking error
 * (OK only) and a confirmation (Cancel / confirm) for anything irreversible —
 * a fit that would move a corner metres, or deleting a node several planes are
 * standing on.
 *
 * Closes on Esc, per the project's modal rule — Esc CANCELS, so an accidental
 * dismissal can never apply the thing the user was still deciding about.
 *
 * @param {{title:string, message:string, confirmLabel?:string,
 *          onConfirm?:function}} opts
 */
function showPlaneDialog(opts) {
    var overlay = document.createElement('div');
    overlay.className = 'plane-confirm-overlay';
    overlay.id = 'planeDialog';

    var modal = document.createElement('div');
    modal.className = 'plane-confirm-modal';

    var h = document.createElement('h3');
    h.textContent = opts.title;
    modal.appendChild(h);

    var body = document.createElement('div');
    body.className = 'plane-confirm-message';
    body.id = 'planeDialogMessage';
    body.textContent = opts.message;
    modal.appendChild(body);

    var actions = document.createElement('div');
    actions.className = 'modal-actions';

    function close() {
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.remove();
    }
    function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
    }

    if (opts.onConfirm) {
        var cancel = document.createElement('button');
        cancel.id = 'btnPlaneDialogCancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', close);
        actions.appendChild(cancel);

        var ok = document.createElement('button');
        ok.id = 'btnPlaneDialogConfirm';
        ok.className = 'primary';
        ok.textContent = opts.confirmLabel || 'Continue';
        ok.addEventListener('click', function () {
            close();
            opts.onConfirm();
        });
        actions.appendChild(ok);
    } else {
        var dismiss = document.createElement('button');
        dismiss.id = 'btnPlaneDialogDismiss';
        dismiss.className = 'primary';
        dismiss.textContent = 'OK';
        dismiss.addEventListener('click', close);
        actions.appendChild(dismiss);
    }

    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
}

// ============================================
// Pushing planes into the 3D viewport
// ============================================

/**
 * Push every plane that has 3D into the 3D viewport.
 *
 * Rebuilds the whole `_planeGroup`, so it is also the "remove" path — a plane
 * whose 3D was invalidated simply stops being in the payload. Safe to call when
 * the viewport does not exist yet (`viewport3d` is a live binding that is null
 * before `setup3DViewport` and again between a dispose and re-create).
 */
export function syncPlanes3D() {
    if (!viewport3d || !viewport3d.setPlanes) return;
    // Wire the 3D drag callbacks here rather than at construction: the viewport
    // is re-created by `setup3DViewport` (each session load), and this is the
    // one function every path that touches plane 3D already calls. Assignment
    // is idempotent, so re-running it costs nothing.
    viewport3d.onPlaneNodeDragged = onPlaneNodeDragged3D;
    viewport3d.onPlaneNodeDragEnd = onPlaneNodeDragEnd3D;
    viewport3d.planeNodeSize = planeState.nodeSize3d;
    attachOriginCallbacks(viewport3d);

    var model = planeModel();
    var pool = model.pool;
    var payload = [];
    for (var i = 0; i < model.planes.length; i++) {
        var plane = model.planes[i];
        if (!planeHasAny3d(plane)) continue;
        payload.push({
            id: plane.id,
            name: plane.name,
            color: plane.color,
            nodeColors: planeNodeColors(plane, pool),
            // Parallel to the plane's own node order, like `nodeColors`. The
            // viewport ANDs this into per-corner draggability so a pinned
            // corner does not offer a `move` cursor for a drag the edit path
            // refuses. Pinning is a property of the NODE, so a corner shared
            // with another plane is pinned in every plane at once.
            nodeImmutable: planeNodeImmutability(plane, pool),
            edges: planeEdgesLocal(plane),
            // The FILL's vertex ring, not membership order: the user's edge
            // ring when they drew one, else the convex hull of the plane's 3D
            // points, so a node in the middle of a plane is enclosed by the
            // fill instead of pulling the outline in to itself.
            polygonOrder: planeFillOrder3d(plane, pool),
            filled: plane.filled,
            // Corners are draggable in 3D only once the plane has been FIT —
            // the fit is what supplies the surface a corner is allowed to slide
            // along. Gated on the mode too, matching 2D: outside Defining Plane
            // Mode a plane is visible but inert in both representations.
            // Set Origin Mode also turns dragging off — a corner must not move
            // out from under the click that is selecting it as the origin.
            editable: planeState.active && !isOriginModeActive() && !!plane.planeFit,
            planeFit: plane.planeFit,
            points3d: points3dForPlane(plane, pool),
        });
    }
    viewport3d.setPlanes(payload);
}

// ============================================
// Dragging a plane corner in the 3D viewport
// ============================================

/** @type {number|null} Node id we last refused to drag, so the reason is said once. */
var _refused3dNodeId = null;

/**
 * Move one corner of a fitted plane, in 3D, to a point the viewport has
 * already constrained to that plane. Runs on every pointer move of the drag.
 *
 * The 2D follows the 3D here, which is the reverse of every other edit path in
 * the app — and it is the only consistent choice: a corner that has been fitted
 * is DEFINED by the plane, so its views are just where that 3D point lands.
 * Written through `reprojectPointCamera` (which applies distortion), not
 * `Camera.project`, because annotations live in native distorted pixel space.
 *
 * A PINNED node is refused here, once per drag attempt, with the reason in the
 * status bar. The viewport cannot filter it out on its own — its payload marks
 * draggability per PLANE, not per node — so this is where the pin is enforced.
 *
 * `plane.planeFit` is deliberately NOT re-derived. Centroid + normal are what a
 * later step turns into the origin's translation + rotation; a corner nudge must
 * not move the frame it defines.
 *
 * @param {number} planeId
 * @param {number} nodeIdx - Index into the plane's own node order.
 * @param {number[]} xyz - already on the fitted plane
 */
function onPlaneNodeDragged3D(planeId, nodeIdx, xyz) {
    var model = planeModel();
    var pool = model.pool;
    var plane = model.getPlane(planeId);
    if (!plane || !plane.planeFit) return;
    if (!(nodeIdx >= 0) || nodeIdx >= plane.nodeIds.length) return;
    if (!xyz || !isFinite(xyz[0]) || !isFinite(xyz[1]) || !isFinite(xyz[2])) return;

    var nodeId = plane.nodeIds[nodeIdx];
    var node = pool.getNode(nodeId);
    if (!node) return;
    if (node.immutable) {
        if (_refused3dNodeId !== nodeId) {
            _refused3dNodeId = nodeId;
            setStatus('"' + node.name + '" is pinned — unpin it in the Nodes table to move it',
                'warning');
        }
        return;
    }
    _refused3dNodeId = null;
    node.setPoint3d(xyz);

    var session = state.session;
    var poolIdx = pool.indexOf(nodeId);
    if (session && session.cameras && poolIdx >= 0) {
        for (var c = 0; c < session.cameras.length; c++) {
            var cam = session.cameras[c];
            if (!model.isPlanePlaced(plane, cam.name)) continue;
            var inst = model.getInstance(cam.name);
            if (!inst || poolIdx >= inst.numNodes) continue;
            var uv = reprojectPointCamera(xyz, cam);
            if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) continue;
            inst.setPoint(poolIdx, uv[0], uv[1]);
            inst.modified = true;
        }
    }

    // Both representations, every move — that is what makes the drag readable.
    // The panel is NOT rebuilt here: it re-creates its inputs (including the
    // name field the user may be typing in) and would cost a full DOM pass per
    // mouse move. It catches up on drag end.
    syncPlanes3D();
    redraw();
}

/** End of a 3D corner drag: do the work that is too expensive to do per move. */
function onPlaneNodeDragEnd3D(planeId, nodeIdx) {
    _refused3dNodeId = null;
    var model = planeModel();
    var plane = model.getPlane(planeId);
    if (!plane) return;
    // The viewport reports a drag as "moved" from its own pointer travel, but a
    // pinned node refused every one of those moves. Saying "Moved …" here would
    // overwrite the refusal with a claim that is simply false.
    var node = model.pool.getNode(plane.nodeIds[nodeIdx]);
    if (node && node.immutable) {
        setStatus('"' + node.name + '" is pinned — untick Pin in the Nodes table ' +
            'to move it', 'warning');
        return;
    }
    // The 2D was written to the exact reprojection of the moved 3D, so the
    // stored per-node errors are stale — re-derive them against what is now on
    // screen rather than leaving the panel reporting the pre-drag numbers.
    refreshTriangulationErrors(plane);
    markDirty();
    refreshPlanePanel();
    setStatus('Moved "' + planeNodeNameAt(plane, nodeIdx) + '" on plane "' + plane.name +
        '" — it stays on the fitted plane');
}

// ============================================
// Mode enter / exit
// ============================================

export function isPlaneModeActive() {
    return planeState.active;
}

// ============================================
// The annotation toolbar, while the mode is on
// ============================================

/**
 * The toolbar buttons Defining Plane Mode blocks.
 *
 * All of them act on POSE annotation — instances, groups, pose triangulation,
 * tracking — which is a different object than the plane geometry the mode is
 * for. In the mode a click lands on a plane node, the info panel is the plane
 * panel, and `interactionManager`'s selection is a plane; pressing Group or
 * Triangulate here operates on a pose selection the user can no longer see or
 * change, so the result is an edit they did not mean to make and cannot
 * observe. Blocked rather than merely ignored, because a button that silently
 * does nothing is indistinguishable from one that is broken.
 *
 * The VISIBILITY controls are deliberately absent from this list, and so are
 * Sessions, Color and Hide Panel. Those change what is DRAWN, not what is
 * annotated — turning Predicted off to see the plane you are placing is
 * exactly the kind of thing this mode is for.
 *
 * @type {string[]}
 */
const PLANE_LOCKED_TOOLBAR_IDS = [
    'tbAddInstance', 'tbDeleteInstance',
    'tbGroup', 'tbEditGroup', 'tbTriangulate', 'tbTriangulateAll',
    'tbTrackFrame', 'tbTrackAll',
];

/**
 * The dropdown WRAPPERS whose menus must be locked with their button.
 *
 * `#tbTriangulate` / `#tbTriangulateAll` each sit inside a `.tri-dropdown`
 * whose menu opens on **hover** (CSS) and whose DLT / BA entries are `div`s
 * with their own click handlers. `disabled` on the button reaches neither, so
 * without this the button greys out while its menu still triangulates.
 *
 * @type {string[]}
 */
const PLANE_LOCKED_DROPDOWN_IDS = ['triangulateDropdown', 'triangulateAllDropdown'];

/** Suffix appended to a locked button's tooltip, so "why?" is answered in place. */
const LOCKED_TITLE_SUFFIX = ' — not available in Defining Plane Mode';

/**
 * Apply (or lift) the mode's toolbar lock.
 *
 * Idempotent, and safe to call as often as you like — which it has to be,
 * because `drawAllOverlays` RECOMPUTES `tbGroup.disabled` / `tbEditGroup.disabled`
 * from the pose selection on every overlay draw, and the mode redraws
 * constantly. So this is re-asserted from there too rather than only on entry;
 * setting `disabled` once at `enterPlaneMode` would survive exactly until the
 * first mouse move.
 *
 * Each button's PRIOR `disabled` is recorded at lock time and restored on exit,
 * the same rule `lockUI` in `ui/origin-definition.js` follows: several of these
 * are disabled for their own reasons (Edit Group with a reprojected instance
 * selected, Track All mid-run), and blanket-enabling on exit would misreport
 * what is clickable. For `tbGroup` / `tbEditGroup` the snapshot is belt and
 * braces only — `drawAllOverlays` OWNS those two and re-derives them on the
 * redraw `exitPlaneMode` triggers, so a stale snapshot cannot stick.
 */
export function applyPlaneModeToolbarLock() {
    var on = planeState.active;
    for (var i = 0; i < PLANE_LOCKED_TOOLBAR_IDS.length; i++) {
        var btn = document.getElementById(PLANE_LOCKED_TOOLBAR_IDS[i]);
        if (!btn) continue;
        if (on) {
            // Snapshot once, on the transition — re-snapshotting on the
            // re-assert from `drawAllOverlays` would record the LOCKED state
            // and make the restore a no-op.
            if (!btn.classList.contains('plane-mode-locked')) {
                btn.dataset.planeUnlockedTitle = btn.title || '';
                btn.dataset.planeUnlockedDisabled = btn.disabled ? '1' : '';
                btn.title = (btn.title || btn.textContent.trim()) + LOCKED_TITLE_SUFFIX;
                btn.classList.add('plane-mode-locked');
            }
            btn.disabled = true;
        } else if (btn.classList.contains('plane-mode-locked')) {
            btn.classList.remove('plane-mode-locked');
            btn.title = btn.dataset.planeUnlockedTitle || '';
            btn.disabled = btn.dataset.planeUnlockedDisabled === '1';
            delete btn.dataset.planeUnlockedTitle;
            delete btn.dataset.planeUnlockedDisabled;
        }
    }
    for (var d = 0; d < PLANE_LOCKED_DROPDOWN_IDS.length; d++) {
        var wrap = document.getElementById(PLANE_LOCKED_DROPDOWN_IDS[d]);
        if (wrap) wrap.classList.toggle('plane-mode-locked', on);
    }
}

export function enterPlaneMode() {
    if (planeState.active) return;
    planeState.active = true;

    var bar = document.getElementById('planeModeBar');
    if (bar) bar.style.display = '';

    setPanelPlaneMode(true);
    applyPlaneModeToolbarLock();

    // No plane is minted on entry. An empty Planes list is the honest starting
    // state; a phantom `plane_1` nobody asked for is something the user then
    // has to notice and delete, and it would be indistinguishable from one
    // they created and forgot. The Edit Plane section carries its own
    // empty state, so the panel is not a dead end without it.
    // An EXISTING plane is still re-selected, so re-entering the mode resumes
    // where it left off.
    var model = planeModel();
    if (planeState.selectedPlaneId == null && model.planes.length) {
        planeState.selectedPlaneId = model.planes[0].id;
    }

    refreshPlanePanel();
    redraw();
    // The mode gates 3D corner dragging as well as 2D, so the scene has to be
    // re-pushed for the `editable` flag to flip.
    syncPlanes3D();
    setStatus('Defining Plane Mode — drag a plane onto a video view', 'success');
}

export function exitPlaneMode() {
    if (!planeState.active) return;
    // Set Origin Mode is entered from inside this one and locks the UI, so
    // leaving without unwinding it would strand every button disabled.
    if (isOriginModeActive()) exitOriginMode();
    planeState.active = false;

    var bar = document.getElementById('planeModeBar');
    if (bar) bar.style.display = 'none';

    setPanelPlaneMode(false);
    applyPlaneModeToolbarLock();
    clearDropTargetHighlight();
    // Leaving the mode makes planes inert, so a lingering selection/hover
    // highlight would advertise an interaction that no longer works.
    if (interactionManager) {
        interactionManager.selectPlane(null, -1);
        interactionManager.hoveredPlaneNode = null;
    }
    redraw();
    syncPlanes3D();
    setStatus('Left Defining Plane Mode', 'success');
}

export function togglePlaneMode() {
    if (planeState.active) exitPlaneMode();
    else enterPlaneMode();
}

/**
 * Swap the info panel between its normal tabbed content and the Define Plane
 * panel. The tab bar's own layout code (`setupPanelTabs`) is untouched — we
 * only toggle visibility, so restoring is exact.
 */
function setPanelPlaneMode(on) {
    var tabBar = document.querySelector('.panel-tabs');
    if (tabBar) tabBar.style.display = on ? 'none' : '';
    document.querySelectorAll('.panel-tab-content').forEach(function (el) {
        // Only the ACTIVE tab is normally visible; `.active` still governs
        // that, so we just force-hide all of them while the mode is on.
        el.style.display = on ? 'none' : '';
    });
    var panel = document.getElementById('planePanel');
    if (panel) panel.style.display = on ? '' : 'none';
}

// ============================================
// Define Plane panel
// ============================================

/** Rebuild every table + input in the Define Plane panel from `planeState`. */
export function refreshPlanePanel() {
    var panel = document.getElementById('planePanel');
    if (!panel) return;
    renderEditor();
    renderPlanesTable();
    renderActionRow();
    renderOriginButton();
    renderOriginResult();
}

function makeDeleteButton(title, onClick) {
    var btn = document.createElement('button');
    btn.textContent = '×';
    btn.className = 'panel-btn';
    btn.style.cssText = 'padding:0 5px;font-size:14px;line-height:1;min-width:0;color:var(--error-color);';
    btn.title = title;
    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        onClick();
    });
    return btn;
}

function setEmptyState(tableId, emptyId, isEmpty) {
    var table = document.getElementById(tableId);
    var empty = document.getElementById(emptyId);
    if (table) table.style.display = isEmpty ? 'none' : '';
    if (empty) empty.style.display = isEmpty ? '' : 'none';
}

// --- Section 1: the global Nodes table --------------------------------------

/**
 * Section 2 — Edit Plane: WHICH plane is being edited, and what it is made of
 * (its name, which nodes are in it, and its connections).
 *
 * Everything BELOW the selector is empty-stated as a whole rather than shown
 * half-dead, because every control in it needs a plane to act on: a name field
 * with nothing to name and an "add node" dropdown with nowhere to add to are
 * worse than an explanation. The SELECTOR itself stays live either way — with
 * no plane it is the shortest path to making one.
 */
function renderEditor() {
    var plane = getSelectedPlane();

    // Name the plane in the section header — with three sibling sections the
    // reader needs to know WHICH plane the controls below belong to without
    // cross-referencing the Planes table.
    var title = document.getElementById('planeEditorTitle');
    if (title) title.textContent = plane ? plane.name : '— none selected';

    renderPlaneSelect(plane);

    var body = document.getElementById('planeEditorContent');
    var empty = document.getElementById('planeEditorEmpty');
    if (body) body.style.display = plane ? '' : 'none';
    if (empty) empty.style.display = plane ? 'none' : '';

    var nameInput = document.getElementById('planeSkeletonName');
    if (nameInput) {
        nameInput.value = plane ? plane.name : '';
        nameInput.disabled = !plane;
    }

    renderNodesTable();
    renderFrozenWarning();
    renderPlaneMembers(plane);
    renderAddNodeSelect(plane);
    renderEdgeSelects(plane);
    renderEditorEdges(plane);
}

/**
 * The `<option>` value of the pinned "+ New Plane" entry. A string that can
 * never be a plane id, so `parseInt` on a real selection cannot collide with
 * it. @private
 */
const NEW_PLANE_OPTION = 'new';

/** The `<option>` value meaning "nothing selected". @private */
const NO_PLANE_OPTION = '';

/**
 * Fill the plane SELECTOR at the top of the Edit Plane section.
 *
 * Every plane, in creation order, plus "+ New Plane" pinned LAST. Last rather
 * than first because the list is what the control is for — a creation entry at
 * the top pushes the planes down and is hit by every mis-aimed click meant for
 * the first one.
 *
 * This control cannot rename anything: the option text is a plane's name but
 * the option VALUE is its id, so a rename (in the Name field below) simply
 * relabels an entry rather than moving the selection. With no plane selected a
 * placeholder holds the displayed value — a disabled one, so the user cannot
 * choose "nothing" back once they are editing a plane.
 *
 * @param {PlaneSkeleton|null} plane - The selected plane.
 */
function renderPlaneSelect(plane) {
    var select = document.getElementById('planeSelect');
    if (!select) return;
    select.textContent = '';

    var planes = getPlanes();
    if (!plane) {
        var ph = document.createElement('option');
        ph.value = NO_PLANE_OPTION;
        ph.disabled = true;
        ph.textContent = planes.length ? '— select a plane —' : '— no planes yet —';
        select.appendChild(ph);
    }
    planes.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = String(p.id);
        opt.textContent = p.name;
        select.appendChild(opt);
    });

    var mint = document.createElement('option');
    mint.value = NEW_PLANE_OPTION;
    mint.textContent = '+ New Plane';
    select.appendChild(mint);

    // Assigned AFTER the options exist, or the browser has nothing to match.
    select.value = plane ? String(plane.id) : NO_PLANE_OPTION;
}

/**
 * Section 1 — the Nodes table: the GLOBAL POOL, on its own, as a top-level
 * section.
 *
 * It is deliberately NOT inside the plane editor. A node outlives the planes
 * that reference it and may belong to several at once, so presenting node
 * creation as a sub-step of editing one plane misstates the model. Everything
 * in this table acts on the NODE — renaming, recolouring, pinning and deleting
 * all apply to every plane using it — and there is no membership column: which
 * plane a node is IN is the Edit Plane section's business.
 */
function renderNodesTable() {
    var tbody = document.querySelector('#planeNodesTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    var model = planeModel();
    var pool = model.pool;
    var nodes = pool.nodes;
    setEmptyState('planeNodesTable', 'planeNodesEmpty', nodes.length === 0);

    nodes.forEach(function (node) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-plane-node-id', String(node.id));
        var st = nodeFreezeState(node);
        var usedBy = model.planesForNode(node.id);
        tr.className = 'plane-node-row plane-node-' + st +
            // A node in no plane is NOT an error — planes are deleted without
            // taking their nodes, so this is a normal resting state. It is
            // dimmed only because nothing draws it on any view yet.
            (usedBy.length === 0 ? ' plane-node-unused' : '') +
            (usedBy.length > 1 ? ' plane-node-shared' : '');

        // --- Name (renames the node everywhere it is used) ---
        var tdName = document.createElement('td');
        var input = document.createElement('input');
        input.type = 'text';
        input.value = node.name;
        input.className = 'plane-text-input';
        input.style.width = '100%';
        input.title = 'Node name, shared by every plane using it';
        input.addEventListener('change', function () {
            var newName = input.value.trim();
            if (!newName) { input.value = node.name; return; }
            node.name = newName;
            markDirty();
            refreshPlanePanel();
            redraw();
        });
        tdName.appendChild(input);

        // Per-node colour. Scoped to the NODE, so this corner is the same
        // colour on every view and in every plane — that is the cross-view
        // correspondence cue you check before triangulating.
        var tdColor = document.createElement('td');
        var color = document.createElement('input');
        color.type = 'color';
        color.className = 'plane-node-color';
        color.value = node.color;
        color.title = 'Colour for "' + node.name + '" on every view and in every plane';
        color.addEventListener('input', function () {
            node.color = color.value;
            redraw();
        });
        color.addEventListener('change', function () {
            node.color = color.value;
            markDirty();
            syncPlanes3D();
            refreshPlanePanel();
            redraw();
        });
        color.addEventListener('click', function (e) { e.stopPropagation(); });
        tdColor.appendChild(color);

        // --- Pin: freeze this node's 3D ---
        var tdPin = document.createElement('td');
        var pin = document.createElement('input');
        pin.type = 'checkbox';
        pin.className = 'plane-node-pin';
        pin.checked = node.immutable;
        pin.title = node.immutable
            ? 'Pinned: this 3D position is frozen. Nothing — 2D editing, ' +
              'triangulation or fitting — may move it. Untick to release it.'
            : 'Pin this node: freeze its 3D position so no solve can move it. ' +
              'A fit will then be constrained to pass through it.';
        pin.addEventListener('click', function (e) { e.stopPropagation(); });
        pin.addEventListener('change', function () {
            node.immutable = pin.checked;
            // Pinning changes what a fit is allowed to do, so any stored fit of
            // a plane standing on this node was solved under different rules.
            var planes = model.planesForNode(node.id);
            for (var i = 0; i < planes.length; i++) planes[i].planeFit = null;
            markDirty();
            syncPlanes3D();
            refreshPlanePanel();
            redraw();
        });
        tdPin.appendChild(pin);

        // --- 3D state ---
        var tdState = document.createElement('td');
        var badge = document.createElement('span');
        badge.className = 'plane-node-state plane-node-state-' + st;
        badge.textContent = nodeStateLabel(node, st);
        badge.title = nodeStateTitle(node, st, model);
        tdState.appendChild(badge);

        var tdDel = document.createElement('td');
        tdDel.appendChild(makeDeleteButton(
            'Delete "' + node.name + '" from the PROJECT: every plane using it, ' +
            'its 3D, and its 2D on every view. To take it out of ONE plane, use ' +
            'the × in Nodes In This Plane instead.',
            function () { deleteNodeWithConfirm(node, usedBy); }));

        tr.appendChild(tdName);
        tr.appendChild(tdColor);
        tr.appendChild(tdPin);
        tr.appendChild(tdState);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
    });
}

/**
 * Delete a pool node, asking first when it is load-bearing.
 *
 * Deleting a node is the one destructive act in this panel that reaches
 * BEYOND the plane being edited: it takes the node out of every plane that
 * references it and destroys its 2D on every view. When it is shared, or
 * pinned (a coordinate the user entered deliberately and no solve can
 * reproduce), the confirmation names exactly what is going.
 *
 * A node used by one plane and not pinned is deleted straight away — the ×
 * next to it is unambiguous, and the non-destructive alternative (taking it out
 * of one plane) is the × in the selected plane's own members table.
 *
 * @param {PlaneNode} node
 * @param {PlaneSkeleton[]} usedBy - Planes referencing it.
 */
function deleteNodeWithConfirm(node, usedBy) {
    var model = planeModel();
    var doIt = function () {
        model.deleteNode(node.id);
        markDirty();
        syncPlanes3D();
        refreshPlanePanel();
        redraw();
    };
    var pinned = node.immutable;
    if (usedBy.length < 2 && !pinned) { doIt(); return; }

    var parts = [];
    if (usedBy.length > 1) {
        parts.push('"' + node.name + '" is shared by ' + usedBy.length + ' planes (' +
            usedBy.map(function (p) { return p.name; }).join(', ') +
            '). Deleting it removes that corner from all of them — if they meet ' +
            'along it, they stop meeting.');
    }
    if (pinned) {
        parts.push('It is PINNED' +
            (node.hasPoint3d() ? ' at (' + node.getPoint3d().map(function (v) {
                return v.toFixed(1);
            }).join(', ') + ')' : '') +
            '. That coordinate is an input no solve can reproduce, so deleting ' +
            'it cannot be undone by re-triangulating.');
    }
    parts.push('Its 2D points on every view go with it.');
    showPlaneDialog({
        title: 'Delete node "' + node.name + '"?',
        message: parts.join(' '),
        confirmLabel: 'Delete node',
        onConfirm: doIt,
    });
}

/** Short label for a node's 3D state. @private */
function nodeStateLabel(node, st) {
    if (st === 'frozen') return 'pinned 3D';
    if (st === 'frozen-unsolved') return 'pinned, no 3D';
    return node.hasPoint3d() ? '3D' : '—';
}

/** Long-form explanation, including the coordinates when there are any. @private */
function nodeStateTitle(node, st, model) {
    var used = model.planesForNode(node.id);
    var where = used.length
        ? 'In ' + used.length + ' plane(s): ' +
          used.map(function (p) { return p.name; }).join(', ')
        // Not an error: planes are deleted without their nodes, so a node can
        // legitimately belong to nothing. It just is not drawn anywhere.
        : 'In no plane, so it is drawn on no view — put it in one with + Add ' +
          'in the Edit Plane section';
    if (st === 'frozen-unsolved') {
        return where + '. PINNED BUT NEVER TRIANGULATED — a dead end: pinning is ' +
            'exactly what forbids a solve from giving it a 3D position. Unpin it, ' +
            'triangulate, then pin it again.';
    }
    if (!node.hasPoint3d()) return where + '. No 3D yet — triangulate the plane.';
    var q = node.getPoint3d();
    return where + '. 3D (' + q[0].toFixed(1) + ', ' + q[1].toFixed(1) + ', ' +
        q[2].toFixed(1) + ')' +
        (node.error != null ? ' — ' + node.error.toFixed(2) + ' px reprojection' : '') +
        (st === 'frozen' ? '. Pinned: frozen against every solve.' : '');
}

/**
 * Name the pinned-but-untriangulated nodes in the panel itself.
 *
 * This state cannot resolve itself: the pin is what stops a solve from ever
 * writing a 3D position, so a user who pins a node before triangulating gets a
 * node that silently contributes nothing and blocks every fit of every plane it
 * belongs to (`no_anchor_3d`). A tooltip is not read by someone who does not
 * already suspect a problem, so it is said in the open.
 */
function renderFrozenWarning() {
    var host = document.getElementById('planeFrozenWarning');
    if (!host) return;
    var pool = planePool();
    var stuck = pool.nodes.filter(function (n) {
        return nodeFreezeState(n) === 'frozen-unsolved';
    });
    if (!stuck.length) {
        host.style.display = 'none';
        host.textContent = '';
        return;
    }
    host.style.display = '';
    host.textContent = (stuck.length === 1 ? 'Node ' : 'Nodes ') +
        stuck.map(function (n) { return '"' + n.name + '"'; }).join(', ') +
        (stuck.length === 1 ? ' is' : ' are') +
        ' pinned but have no 3D position. Pinning is what stops triangulation ' +
        'from giving them one, so they will stay empty and will block any fit ' +
        'of a plane they belong to. Unpin, triangulate, then pin again.';
}

/**
 * The Edit Plane members table: the nodes IN the selected plane, in the plane's
 * own order.
 *
 * The × here is a REFERENCE removal — `removeNodeFromPlane` with
 * `deleteIfOrphan:false`, so the node stays in the pool with its 3D, its pin
 * and its 2D on every view even if this was the last plane using it. Destroying
 * a node is the Nodes table's × and asks first; keeping the two apart is what stops
 * "take this corner out of this wall" from silently meaning "throw the corner
 * away".
 *
 * The colour is a read-only swatch rather than a second picker: colour is a
 * property of the NODE, so it is edited in one place (the Nodes table) and shown
 * here only as the cross-view correspondence cue it is.
 */
function renderPlaneMembers(plane) {
    var tbody = document.querySelector('#planeMembersTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    var ids = plane ? plane.nodeIds : [];
    setEmptyState('planeMembersTable', 'planeMembersEmpty', ids.length === 0);
    if (!plane) return;

    var model = planeModel();
    var pool = model.pool;
    ids.forEach(function (id) {
        var node = pool.getNode(id);
        if (!node) return;
        var tr = document.createElement('tr');
        tr.setAttribute('data-plane-member-id', String(id));
        var usedBy = model.planesForNode(id);
        // Same marker as the pool table, so a corner shared with another plane
        // reads the same wherever the user meets it.
        if (usedBy.length > 1) tr.className = 'plane-node-row plane-node-shared';

        var tdName = document.createElement('td');
        tdName.className = 'plane-member-name';
        tdName.textContent = node.name;
        tdName.title = usedBy.length > 1
            ? '"' + node.name + '" is shared with ' +
              usedBy.filter(function (p) { return p.id !== plane.id; })
                  .map(function (p) { return p.name; }).join(', ')
            : 'Only "' + plane.name + '" uses this node';

        var tdColor = document.createElement('td');
        var swatch = document.createElement('span');
        swatch.className = 'plane-swatch plane-member-swatch';
        swatch.style.background = node.color;
        swatch.title = 'Colour is a property of the node — change it in the Nodes table';
        tdColor.appendChild(swatch);

        var tdDel = document.createElement('td');
        tdDel.appendChild(makeDeleteButton(
            'Take "' + node.name + '" out of plane "' + plane.name +
            '" only. The node stays in the project' +
            (usedBy.length > 1 ? ' and in the other plane(s) using it' : '') +
            ' — delete it in the Nodes table if you want it gone.',
            function () {
                model.removeNodeFromPlane(plane, id, { deleteIfOrphan: false });
                markDirty();
                syncPlanes3D();
                refreshPlanePanel();
                redraw();
            }));

        tr.appendChild(tdName);
        tr.appendChild(tdColor);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
    });
}

/**
 * Fill the "add an existing node" dropdown with every POOL node that is not
 * already in the selected plane.
 *
 * This is the headline affordance of the whole model: adding the SAME node to a
 * second plane is how two planes come to meet along a shared line, so it is a
 * visible control with its own button rather than a checkbox buried in a row.
 * An empty list is a real state (every node is already in this plane), and it
 * is stated in words instead of leaving a dead dropdown.
 */
function renderAddNodeSelect(plane) {
    var select = document.getElementById('planeAddNodeSelect');
    var btn = document.getElementById('btnAddExistingPlaneNode');
    var hint = document.getElementById('planeAddNodeHint');
    if (select) select.textContent = '';

    var model = planeModel();
    var pool = model.pool;
    var candidates = plane
        ? pool.nodes.filter(function (n) { return !plane.hasNode(n.id); })
        : [];

    if (select) {
        // Values are NODE IDS — names are user-editable and can collide, and
        // pool indices shift under a delete.
        candidates.forEach(function (node) {
            var opt = document.createElement('option');
            opt.value = String(node.id);
            var used = model.planesForNode(node.id);
            opt.textContent = node.name +
                (used.length ? '  (in ' + used.map(function (p) { return p.name; }).join(', ') + ')' : '');
            select.appendChild(opt);
        });
        select.disabled = candidates.length === 0;
    }
    if (btn) btn.disabled = !plane || candidates.length === 0;
    if (hint) {
        if (!plane) hint.textContent = '';
        else if (pool.size === 0) {
            hint.textContent = 'No nodes exist yet — create one with + Node above.';
        } else if (candidates.length === 0) {
            hint.textContent = 'Every node in the project is already in "' + plane.name +
                '". Create a new one with + Node above.';
        } else {
            hint.textContent = 'Adding a node that another plane already uses is what ' +
                'makes the two planes meet along it: one node, one 3D point, one 2D ' +
                'point per view.';
        }
    }
}

/** Fill the two connection dropdowns from the SELECTED plane's nodes. @private */
function renderEdgeSelects(plane) {
    var srcSelect = document.getElementById('planeEdgeSrcSelect');
    var dstSelect = document.getElementById('planeEdgeDstSelect');
    if (srcSelect) srcSelect.textContent = '';
    if (dstSelect) dstSelect.textContent = '';
    if (!plane) return;
    var pool = planePool();
    // Values are NODE IDS, not indices: an edge is stored as an id pair so it
    // cannot silently re-point at a neighbour when the pool or the plane's own
    // order changes, and the option value has to speak the same language.
    plane.nodeIds.forEach(function (id) {
        var node = pool.getNode(id);
        if (!node) return;
        if (srcSelect) {
            var o1 = document.createElement('option');
            o1.value = String(id);
            o1.textContent = node.name;
            srcSelect.appendChild(o1);
        }
        if (dstSelect) {
            var o2 = document.createElement('option');
            o2.value = String(id);
            o2.textContent = node.name;
            dstSelect.appendChild(o2);
        }
    });
    // Default the destination to the second node so the common
    // "connect the next one" case is one click.
    if (dstSelect && plane.nodeIds.length > 1) dstSelect.value = String(plane.nodeIds[1]);
}

function renderEditorEdges(plane) {
    var tbody = document.querySelector('#planeEdgesTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    var edges = plane ? plane.edges : [];
    setEmptyState('planeEdgesTable', 'planeEdgesEmpty', edges.length === 0);
    if (!plane) return;
    var pool = planePool();

    edges.forEach(function (edge, edgeIdx) {
        var tr = document.createElement('tr');
        var src = pool.getNode(edge[0]);
        var dst = pool.getNode(edge[1]);

        var tdSrc = document.createElement('td');
        tdSrc.textContent = src ? src.name : '?';
        var tdDst = document.createElement('td');
        tdDst.textContent = dst ? dst.name : '?';

        var tdDel = document.createElement('td');
        tdDel.appendChild(makeDeleteButton('Remove connection', function () {
            plane.removeEdge(edgeIdx);
            markDirty();
            syncPlanes3D();
            refreshPlanePanel();
            redraw();
        }));

        tr.appendChild(tdSrc);
        tr.appendChild(tdDst);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
    });
}

// --- Planes table (drag source) --------------------------------------------

// Inline SVG icons. Drawn rather than taken from a font so the triangulate and
// fill actions read as what they do at 12 px.
const ICON_TRIANGULATE =
    '<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">' +
    '<polygon points="7,2 12.5,11.5 1.5,11.5" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<circle cx="7" cy="2" r="1.5" fill="currentColor"/>' +
    '<circle cx="12.5" cy="11.5" r="1.5" fill="currentColor"/>' +
    '<circle cx="1.5" cy="11.5" r="1.5" fill="currentColor"/></svg>';
const ICON_MESH =
    '<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">' +
    '<polygon points="2,2 12,3.5 11,12 3,10.5" fill="currentColor" fill-opacity="0.45" ' +
    'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<line x1="2" y1="2" x2="11" y2="12" stroke="currentColor" stroke-width="1"/></svg>';
// Scattered points collapsing onto a line — a plane seen edge-on.
const ICON_FIT =
    '<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">' +
    '<line x1="1.5" y1="9.5" x2="12.5" y2="4.5" stroke="currentColor" stroke-width="1.4"/>' +
    '<circle cx="3.5" cy="7.2" r="1.3" fill="currentColor"/>' +
    '<circle cx="7" cy="8" r="1.3" fill="currentColor"/>' +
    '<circle cx="10.5" cy="4.2" r="1.3" fill="currentColor"/></svg>';

/**
 * Enable/disable + relabel the shared Triangulate / Fill / Fit row.
 *
 * All three act on the SELECTED plane, so they are disabled outright when
 * nothing is selected. When something IS selected they stay enabled even if the
 * action's precondition fails (too few views, too few nodes) — clicking then
 * reports WHY in the status bar, which teaches more than a dead button.
 */
function renderActionRow() {
    var plane = getSelectedPlane();
    var triBtn = document.getElementById('btnPlaneTriangulate');
    var fillBtn = document.getElementById('btnPlaneFill');
    var fitBtn = document.getElementById('btnPlaneFit');
    if (!triBtn || !fillBtn || !fitBtn) return;

    [triBtn, fillBtn, fitBtn].forEach(function (b) { b.disabled = !plane; });
    if (!plane) {
        triBtn.title = fillBtn.title = fitBtn.title = 'Select a plane first';
        triBtn.classList.remove('active');
        fillBtn.classList.remove('active');
        fitBtn.classList.remove('active');
        fillBtn.style.color = '';
        return;
    }

    var nPlaced = placedViewsOf(plane).length;

    triBtn.classList.toggle('active', !!plane.triangulation);
    triBtn.title = plane.triangulation
        ? 'Re-triangulate "' + plane.name + '" (currently ' + plane.triangulation.nNodes +
          ' node(s) from ' + plane.triangulation.views.join(', ') + ')'
        : 'Triangulate "' + plane.name + '" across the ' + nPlaced +
          ' view(s) it is placed on, and show it in the 3D viewer';

    fillBtn.classList.toggle('active', !!plane.filled);
    fillBtn.style.color = plane.filled ? plane.color : '';
    fillBtn.title = (plane.filled ? 'Unfill' : 'Fill') + ' the "' + plane.name +
        '" polygon with its colour';

    var nPinned = planeImmutableMask(plane).filter(Boolean).length;
    fitBtn.classList.toggle('active', !!plane.planeFit);
    fitBtn.title = 'Fit a plane of best fit to "' + plane.name + '" and flatten its ' +
        'points onto it, updating the 3D viewer and every 2D view' +
        (nPinned ? ' — constrained to pass through its ' + nPinned + ' pinned node(s)' : '') +
        (plane.planeFit ? ' (last fit moved points ' + plane.planeFit.rms.toFixed(2) +
            ' mm RMS)' : '');
}

/**
 * Set Origin needs a FITTED plane, not a selected one — the wizard picks its
 * corner in the 3D scene, from any fitted plane, so gating it on the panel
 * selection would disable it for a perfectly valid project.
 */
function renderOriginButton() {
    var btn = document.getElementById('btnSetOrigin');
    if (!btn) return;
    var nFit = fittedPlanes().length;
    btn.disabled = nFit === 0;
    btn.title = nFit === 0
        ? 'Fit a plane first — Set Origin picks a corner of a fitted plane'
        : 'Re-define the 3D origin from a corner of one of the ' + nFit +
          ' fitted plane(s)';
}

function renderPlanesTable() {
    var tbody = document.querySelector('#planeSkeletonsTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    var model = planeModel();
    var pool = model.pool;
    setEmptyState('planeSkeletonsTable', 'planeSkeletonsEmpty', model.planes.length === 0);

    model.planes.forEach(function (plane) {
        var views = model.placedViews(plane);
        var tr = document.createElement('tr');
        tr.setAttribute('data-plane-skeleton-id', String(plane.id));
        if (plane.id === planeState.selectedPlaneId) tr.classList.add('plane-selected');

        // A plane with no nodes has nothing to draw, so make it undraggable
        // rather than letting a drop produce an invisible placement.
        var draggable = plane.nodeIds.length > 0;
        tr.draggable = draggable;
        tr.title = draggable
            ? 'Drag onto a video view to place; click to edit'
            : 'Add at least one node before placing this plane';

        // --- Expander: reveals where this plane is placed ---
        var expanded = planeState.expanded.has(plane.id);
        var tdExpand = document.createElement('td');
        var expandBtn = document.createElement('button');
        expandBtn.className = 'plane-expander' + (expanded ? ' open' : '');
        expandBtn.innerHTML = '<span class="plane-caret">▶</span>' +
            '<span class="plane-placed-count">' + views.length + '</span>';
        expandBtn.title = views.length
            ? (expanded ? 'Hide placements' : 'Show the ' + views.length + ' placement(s)')
            : 'Not placed on any view yet';
        expandBtn.disabled = views.length === 0;
        expandBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (planeState.expanded.has(plane.id)) planeState.expanded.delete(plane.id);
            else planeState.expanded.add(plane.id);
            refreshPlanePanel();
        });
        tdExpand.appendChild(expandBtn);

        var tdName = document.createElement('td');
        var swatch = document.createElement('span');
        swatch.className = 'plane-swatch';
        swatch.style.background = plane.color;
        tdName.appendChild(swatch);
        tdName.appendChild(document.createTextNode(plane.name));

        var tdNodes = document.createElement('td');
        tdNodes.className = 'mono';
        tdNodes.textContent = String(plane.nodeIds.length);
        // Shared nodes are the reason the pool exists — say how many, here,
        // where the user is choosing which plane to work on.
        var nShared = plane.nodeIds.filter(function (id) {
            return model.planesForNode(id).length > 1;
        }).length;
        tdNodes.title = nShared
            ? nShared + ' of them shared with another plane'
            : 'No nodes shared with another plane';
        if (nShared) {
            var sharedMark = document.createElement('span');
            sharedMark.className = 'plane-shared-count';
            sharedMark.textContent = '+' + nShared;
            sharedMark.title = nShared + ' node(s) shared with another plane';
            tdNodes.appendChild(sharedMark);
        }

        // --- Actions: delete only. Triangulate / Fill / Fit are in the shared
        // action row below the table, where they act on the SELECTED plane
        // rather than being repeated on every row.
        var tdActions = document.createElement('td');
        tdActions.className = 'plane-actions';

        // A solved plane is worth seeing at a glance without expanding.
        if (plane.triangulation) {
            var badge = document.createElement('span');
            badge.className = 'plane-solved-badge';
            badge.textContent = '3D';
            badge.title = plane.triangulation.nNodes + ' node(s) from ' +
                plane.triangulation.views.join(', ') +
                (plane.planeFit ? ' — fitted' : '');
            tdActions.appendChild(badge);
        }

        tdActions.appendChild(makeDeleteButton(
            'Delete this plane (nodes another plane also uses are kept)', function () {
                deletePlane(plane.id);
                refreshPlanePanel();
                redraw();
            }));

        // The row is the drag handle, so the browser would start a drag from a
        // button press too. Suspending `draggable` while the cursor is over the
        // controls keeps them clickable without giving up row-wide dragging.
        [tdExpand, tdActions].forEach(function (cell) {
            cell.addEventListener('mouseenter', function () { tr.draggable = false; });
            cell.addEventListener('mouseleave', function () { tr.draggable = draggable; });
        });

        tr.addEventListener('click', function () {
            planeState.selectedPlaneId = plane.id;
            refreshPlanePanel();
        });

        tr.addEventListener('dragstart', function (e) {
            if (!draggable) { e.preventDefault(); return; }
            // Private MIME only — see the module note: a `text/plain` payload
            // would be grabbed by dockview's video-panel drop handler.
            e.dataTransfer.setData(PLANE_DRAG_MIME, String(plane.id));
            e.dataTransfer.effectAllowed = 'copy';
        });

        tr.appendChild(tdExpand);
        tr.appendChild(tdName);
        tr.appendChild(tdNodes);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);

        if (expanded && views.length) {
            tbody.appendChild(buildPlacementsRow(plane, views, pool));
        }
    });
}

/**
 * The expanded sub-row for a plane: one line per view it is placed on
 * (click to select, × to un-place), plus the triangulation readout when there
 * is one — a Triangulate button whose result you cannot see would be a dead end.
 */
function buildPlacementsRow(plane, views, pool) {
    var model = planeModel();
    var tr = document.createElement('tr');
    tr.className = 'plane-placements-row';
    tr.setAttribute('data-plane-placements-for', String(plane.id));

    var td = document.createElement('td');
    td.colSpan = 4;

    var selected = interactionManager ? interactionManager.selectedPlane : null;
    var poolIdx = planeNodeIndices(plane, pool);

    views.forEach(function (viewName) {
        var inst = model.getInstance(viewName);
        var row = document.createElement('div');
        row.className = 'plane-placement-item';
        row.setAttribute('data-plane-view', viewName);
        if (inst && inst === selected) row.classList.add('plane-selected');

        var name = document.createElement('span');
        name.className = 'plane-placement-view';
        name.textContent = viewName;
        row.appendChild(name);

        var off = 0, derived = 0;
        for (var i = 0; i < poolIdx.length; i++) {
            if (poolIdx[i] < 0 || !inst) continue;
            if (inst.isNodeNulled(poolIdx[i])) off++;
            else if (inst.isNodeDerived(poolIdx[i])) derived++;
        }
        var meta = document.createElement('span');
        meta.className = 'plane-placement-meta';
        // A view the plane was REPROJECTED onto is placed like any other, so
        // without this the list gives no clue that its corners are the model's
        // output rather than the user's annotation — and that they do not count
        // as evidence in the next solve.
        var bits = [];
        if (off) bits.push(off + ' off');
        if (derived) bits.push(derived + ' reprojected');
        meta.textContent = bits.join(', ');
        if (derived) {
            meta.title = derived + ' corner(s) here were reprojected from the 3D, ' +
                'not annotated on this view — drag one to make it count as an ' +
                'observation in the next triangulation';
        }
        row.appendChild(meta);

        var del = makeDeleteButton(
            'Un-place "' + plane.name + '" from ' + viewName +
            ' (its 2D points are kept, so re-placing restores them)',
            function () {
                unplacePlaneFromView(plane, viewName);
                refreshPlanePanel();
                redraw();
            });
        row.appendChild(del);

        row.addEventListener('click', function () {
            if (interactionManager && inst) interactionManager.selectPlane(inst, -1);
            refreshPlanePanel();
            redraw();
        });
        td.appendChild(row);
    });

    if (plane.triangulation) {
        var t = plane.triangulation;
        var summary = document.createElement('div');
        summary.className = 'plane-tri-summary';
        summary.textContent = '3D: ' + t.nNodes + '/' + plane.nodeIds.length +
            ' nodes from ' + t.views.join(', ') +
            (t.meanError != null ? ' — mean err ' + t.meanError.toFixed(2) + ' px' : '');
        td.appendChild(summary);

        if (t.nAnchors) {
            var anchors = document.createElement('div');
            anchors.className = 'plane-tri-summary plane-anchor-summary';
            // A pinned node's residual is OUT of sample — no degree of freedom
            // was spent fitting it — so it is reported apart from the solve's
            // own error rather than diluting it.
            anchors.textContent = t.nAnchors + ' pinned node(s) held fixed' +
                (t.anchorMeanError != null
                    ? ' — they reproject ' + t.anchorMeanError.toFixed(2) + ' px off'
                    : '');
            td.appendChild(anchors);
        }

        if (plane.planeFit) {
            var f = plane.planeFit;
            var fit = document.createElement('div');
            fit.className = 'plane-tri-summary plane-fit-summary';
            fit.textContent = (f.constrained ? 'Fitted (constrained) — normal (' : 'Fitted plane — normal (') +
                f.normal.map(function (q) { return q.toFixed(3); }).join(', ') +
                '), was ' + f.rms.toFixed(2) + ' mm RMS off-plane';
            fit.title = 'Centroid (' +
                f.centroid.map(function (q) { return q.toFixed(1); }).join(', ') + ')';
            td.appendChild(fit);
        }

        var points3d = points3dForPlane(plane, pool);
        var errors = nodeErrorsForPlane(plane, pool);
        for (var n = 0; n < plane.nodeIds.length; n++) {
            var node = pool.getNode(plane.nodeIds[n]);
            var line = document.createElement('div');
            line.className = 'plane-tri-node';
            var sw = document.createElement('span');
            sw.className = 'plane-swatch';
            sw.style.background = node ? node.color : '#888';
            line.appendChild(sw);
            var text = (node ? node.name : '?') + '  ';
            if (hasPoint3d(points3d, n)) {
                var q = getPoint3d(points3d, n);
                text += '(' + q[0].toFixed(1) + ', ' + q[1].toFixed(1) + ', ' + q[2].toFixed(1) + ')';
                if (errors[n] != null) text += '  ' + errors[n].toFixed(2) + ' px';
            } else {
                text += '—';
            }
            if (node && node.immutable) text += '  pinned';
            line.appendChild(document.createTextNode(text));
            td.appendChild(line);
        }
    }

    tr.appendChild(td);
    return tr;
}

function redraw() {
    drawAllOverlays(state.currentFrame);
}

// ============================================
// Drag and drop onto video views
// ============================================

var _dropTargetEl = null;

function clearDropTargetHighlight() {
    if (_dropTargetEl) _dropTargetEl.classList.remove('plane-drop-target');
    _dropTargetEl = null;
}

function setDropTargetHighlight(cell) {
    if (_dropTargetEl === cell) return;
    clearDropTargetHighlight();
    if (cell) {
        cell.classList.add('plane-drop-target');
        _dropTargetEl = cell;
    }
}

function isPlaneDrag(e) {
    return !!(e.dataTransfer && e.dataTransfer.types &&
        Array.prototype.indexOf.call(e.dataTransfer.types, PLANE_DRAG_MIME) >= 0);
}

/**
 * Wire plane drops on the video dock. Listeners are DELEGATED on the dock
 * container so panes added later are covered without touching
 * `ui/sessions-panes.js`'s renderer.
 */
function setupDockDropTarget() {
    var dock = document.getElementById('videoDock');
    if (!dock) return;

    dock.addEventListener('dragover', function (e) {
        if (!planeState.active || !isPlaneDrag(e)) return;
        var cell = e.target.closest ? e.target.closest('.video-cell') : null;
        if (!cell || !cell.getAttribute('data-view-name')) {
            clearDropTargetHighlight();
            return;
        }
        // preventDefault marks this a valid drop target — without it the
        // browser refuses the drop.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropTargetHighlight(cell);
    });

    dock.addEventListener('dragleave', function (e) {
        if (!planeState.active) return;
        var cell = e.target.closest ? e.target.closest('.video-cell') : null;
        if (cell && cell === _dropTargetEl && !cell.contains(e.relatedTarget)) {
            clearDropTargetHighlight();
        }
    });

    dock.addEventListener('drop', function (e) {
        if (!planeState.active || !isPlaneDrag(e)) return;
        var cell = e.target.closest ? e.target.closest('.video-cell') : null;
        clearDropTargetHighlight();
        if (!cell) return;
        var viewName = cell.getAttribute('data-view-name');
        if (!viewName) return;

        e.preventDefault();
        e.stopPropagation();

        var planeId = parseInt(e.dataTransfer.getData(PLANE_DRAG_MIME), 10);
        handlePlaneDrop(planeId, viewName, e.clientX, e.clientY);
    });

    document.addEventListener('dragend', clearDropTargetHighlight);
}

/**
 * Place plane `planeId` on `viewName` at the drop point.
 * Exported for tests — the drop listener is only a thin adapter over this.
 */
export function handlePlaneDrop(planeId, viewName, clientX, clientY) {
    var model = planeModel();
    var plane = model.getPlane(planeId);
    if (!plane) { setStatus('Unknown plane', 'warning'); return null; }
    if (!plane.nodeIds.length) {
        setStatus('Plane "' + plane.name + '" has no nodes to place', 'warning');
        return null;
    }
    var view = findView(viewName);
    if (!view) { setStatus('No such view: ' + viewName, 'warning'); return null; }
    if (model.isPlanePlaced(plane, viewName)) {
        setStatus('"' + plane.name + '" is already placed on ' + viewName +
            ' — remove that placement first', 'warning');
        return null;
    }

    // Reuse the interaction manager's transform so the drop lands where the
    // cursor is under zoom / pan / rotation, exactly like a click would.
    var vp = interactionManager
        ? interactionManager.canvasToVideo(clientX, clientY, viewName)
        : [(view.videoWidth || 0) / 2, (view.videoHeight || 0) / 2];

    var inst = placePlaneOnView(plane, viewName, vp[0], vp[1]);
    if (!inst) { setStatus('Could not place plane', 'error'); return null; }

    if (interactionManager) interactionManager.selectPlane(inst, -1);
    refreshPlanePanel();
    redraw();
    setStatus('Placed "' + plane.name + '" on ' + viewName, 'success');
    return inst;
}

// ============================================
// Interaction wiring (ui/interaction.js callbacks)
// ============================================

/**
 * The callbacks `ui/interaction.js` needs to hit-test, drag and select plane
 * nodes. Merged into the InteractionManager's callback bag at construction
 * (`pose/initialization.js`) so that module keeps no import of this feature.
 * @returns {Object}
 */
export function planeInteractionCallbacks() {
    return {
        isPlaneEditMode: isPlaneModeActive,
        getPlaneInstances: getPlaneInstances,
        /**
         * Which POOL indices are grabbable on this view. One instance covers
         * the WHOLE pool, so without this filter a node belonging only to an
         * un-placed plane — invisible here — would still take a click.
         */
        getPlaneNodeIndices: function (viewName) {
            return planeModel().visibleNodeIndices(viewName);
        },
        getPlaneEdges: function (planeInstance) {
            if (!planeInstance) return [];
            var model = planeModel();
            var placed = model.placedPlanes(planeInstance.viewName);
            var out = [];
            var seen = {};
            for (var i = 0; i < placed.length; i++) {
                var edges = planeEdgesPoolIndices(placed[i], model.pool);
                for (var e = 0; e < edges.length; e++) {
                    // Two planes sharing an edge would otherwise hit-test it
                    // twice for no benefit.
                    var key = Math.min(edges[e][0], edges[e][1]) + '-' +
                        Math.max(edges[e][0], edges[e][1]);
                    if (seen[key]) continue;
                    seen[key] = true;
                    out.push(edges[e]);
                }
            }
            return out;
        },
        // Hit radius follows the shared Node Size slider, so what you can grab
        // is always what you can see.
        getPlaneNodeSize: function () { return planeState.nodeSize; },
        beginPlaneDrag: beginPlaneDrag,
        onPlaneChanged: onPlaneChanged,
        onPlaneSelectionChanged: function (planeInstance) {
            var statusEl = document.getElementById('statusSelection');
            if (statusEl && planeInstance) {
                var names = planeModel().placedPlanes(planeInstance.viewName)
                    .map(function (p) { return p.name; });
                statusEl.textContent = 'Selection: plane ' +
                    (names.length ? names.join(' + ') : '?') + ' / ' + planeInstance.viewName;
            } else if (statusEl && planeState.active) {
                statusEl.textContent = 'Selection: none';
            }
            refreshPlanePanel();
        },
    };
}

/**
 * May this 2D drag start, and which points may it move?
 *
 * Two things are decided here rather than in `ui/interaction.js`, because both
 * are facts about the plane model:
 *   - A PINNED node is not draggable. Refusing silently would look like a bug,
 *     so the reason goes to the status bar; the click still SELECTS, so the
 *     node stays reachable for un-pinning or toggling off.
 *   - An Alt+drag translates "the whole plane". A view's instance now covers
 *     every node in the pool, so translating all of its points would drag
 *     unrelated planes along; the answer is the nodes of the planes that
 *     actually contain the grabbed node, minus any pinned ones.
 *
 * @param {string} viewName
 * @param {number} nodeIdx - POOL index under the cursor.
 * @param {boolean} wholePlane - Alt was held.
 * @returns {{allowed:boolean, indices:number[]|null}} `indices` null = "every
 *   point of the instance", which only happens for a single-node drag.
 */
function beginPlaneDrag(viewName, nodeIdx, wholePlane) {
    var model = planeModel();
    var node = model.pool.nodeAt(nodeIdx);
    if (!node) return { allowed: false, indices: null };
    if (node.immutable) {
        setStatus('"' + node.name + '" is pinned — untick Pin in the Nodes table ' +
            'to move it', 'warning');
        return { allowed: false, indices: null };
    }
    if (!wholePlane) return { allowed: true, indices: null };

    var planes = model.planesForNode(node.id);
    var indices = [];
    var seen = {};
    var pinned = 0;
    for (var i = 0; i < planes.length; i++) {
        if (!model.isPlanePlaced(planes[i], viewName)) continue;
        for (var j = 0; j < planes[i].nodeIds.length; j++) {
            var id = planes[i].nodeIds[j];
            if (seen[id]) continue;
            seen[id] = true;
            var other = model.pool.getNode(id);
            if (!other) continue;
            if (other.immutable) { pinned++; continue; }
            var idx = model.pool.indexOf(id);
            if (idx >= 0) indices.push(idx);
        }
    }
    if (pinned) {
        setStatus(pinned + ' pinned node(s) stay put — the rest of the plane moves');
    }
    return { allowed: true, indices: indices.length ? indices : null };
}

/**
 * A 2D edit landed: the moved nodes' 3D was solved from 2D that no longer
 * exists, so it goes.
 *
 * Only the NODES that moved are invalidated, not the whole plane: a node's 3D
 * lives on the node now, and clearing a neighbour's would throw away work the
 * edit says nothing about. Pinned nodes are skipped by `invalidateNode3D` —
 * their 3D is an input, not an output — but every plane standing on a moved
 * node still loses its fit, because the fit WAS derived from this 2D.
 *
 * @param {PlaneInstance} inst
 * @param {number[]|null} [movedIndices] - POOL indices the drag touched; null
 *   means "unknown", which is treated as everything visible on that view.
 * @param {{moved?:boolean}} [opts] - `moved:true` = the user DRAGGED these
 *   points. Only a drag promotes a reprojected point to an observation;
 *   right-clicking a node off calls this too and must not.
 */
function onPlaneChanged(inst, movedIndices, opts) {
    if (!inst) return;
    var model = planeModel();
    var indices = movedIndices && movedIndices.length
        ? movedIndices
        : model.visibleNodeIndices(inst.viewName);
    // A point the user moved is THEIRS, whatever put it there — so it stops
    // being a reprojection and starts counting as an observation in this view.
    // Deliberately not done in `setPoint`: the fit's 2D write-back and the 3D
    // corner drag go through the same setter and must NOT promote the model's
    // own output to evidence. Nor does a null-toggle (`moved` false): the user
    // turning a corner off says nothing about where it is, so un-toggling it
    // later must not leave a reprojection counting as an annotation.
    if (opts && opts.moved) inst.clearDerivedNodes(indices);
    for (var i = 0; i < indices.length; i++) {
        var node = model.pool.nodeAt(indices[i]);
        if (node) model.invalidateNode3D(node.id);
    }
    markDirty();      // a drag AND a null-toggle both change what gets saved
    syncPlanes3D();   // drops any plane that lost its last 3D from the scene too
    refreshPlanePanel();
}

// ============================================
// Overlay rendering
// ============================================

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
    for (var p = 0; p < placed.length; p++) {
        var plane = placed[p];
        var edgeColor = plane.color || '#4dd0e1';
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

    // --- nodes, once each ---
    drawPlaneNodes(ctx, model, inst, tf, hovered, view.name);

    // --- plane name at each plane's own centroid ---
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

// ============================================
// Wiring
// ============================================

/**
 * One-time wiring for the plane-mode banner, the Define Plane panel controls,
 * and the dock drop target. Called once from `pose/initialization.js`.
 */
export function setupPlaneDefinition() {
    var exitBtn = document.getElementById('planeModeExit');
    if (exitBtn) exitBtn.addEventListener('click', exitPlaneMode);

    // --- The plane SELECTOR: which plane the editor edits ---
    // Selection is one-way state (`planeState.selectedPlaneId`) that both this
    // dropdown and the Planes table write and both re-read on the next
    // `refreshPlanePanel`, so the two can never disagree without one of them
    // failing to render at all.
    var planeSelect = document.getElementById('planeSelect');
    if (planeSelect) {
        planeSelect.addEventListener('change', function () {
            // Set Origin Mode locks every BUTTON, but this is a <select> that
            // `lockUI` cannot reach — and it would both create state and run a
            // full panel rebuild, which re-enables the very buttons the lock
            // just turned off. Refused here, and only the dropdown is
            // re-rendered so the displayed value goes back.
            if (isOriginModeActive()) {
                setStatus('Finish or leave Set Origin Mode before changing planes', 'warning');
                renderPlaneSelect(getSelectedPlane());
                return;
            }
            if (planeSelect.value === NEW_PLANE_OPTION) {
                // `createPlane` selects the new plane, and the re-render puts
                // the dropdown on it — "+ New Plane" must never be left showing
                // as the current value, because it is an action, not a plane.
                var made = createPlane();
                setStatus('Created plane "' + made.name + '" — add nodes to it with + Add',
                    'success');
                refreshPlanePanel();
                return;
            }
            var id = parseInt(planeSelect.value, 10);
            if (isNaN(id) || !getPlane(id)) return;
            planeState.selectedPlaneId = id;
            refreshPlanePanel();
        });
    }

    var nameInput = document.getElementById('planeSkeletonName');
    if (nameInput) {
        // The one place a plane is RENAMED. `refreshPlanePanel` rebuilds the
        // selector and the Planes table from the model, so both follow.
        nameInput.addEventListener('change', function () {
            var plane = getSelectedPlane();
            if (!plane) return;
            // Same reason as the selector above: an <input> outruns `lockUI`,
            // and its refresh would re-enable the locked action row.
            if (isOriginModeActive()) {
                nameInput.value = plane.name;
                setStatus('Finish or leave Set Origin Mode before renaming a plane', 'warning');
                return;
            }
            var newName = nameInput.value.trim();
            if (!newName) { nameInput.value = plane.name; return; }
            plane.name = newName;
            markDirty();
            syncPlanes3D();
            refreshPlanePanel();
            redraw();
        });
        // Enter commits without waiting for blur.
        nameInput.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
        });
    }

    var nodeInput = document.getElementById('planeNodeNameInput');
    var addNodeBtn = document.getElementById('btnAddPlaneNode');
    if (addNodeBtn) {
        // MINTS A POOL NODE AND NOTHING ELSE. It does not create a plane and
        // does not join one: nodes are plane-independent, so "make a node" and
        // "put a node in this plane" are two acts, and folding them together
        // meant a stray click on an empty panel silently produced a plane the
        // user then had to notice and delete. A node in zero planes is a valid
        // resting state the Nodes table already renders (dimmed, "unused") —
        // `+ Add` in the Edit Plane section is what places it.
        addNodeBtn.addEventListener('click', function () {
            var model = planeModel();
            var name = nodeInput ? nodeInput.value.trim() : '';
            // Default to the next free positional name so four corners are four
            // clicks rather than four clicks plus four typed names.
            if (!name) name = nextFreeNodeName(model.pool);
            if (findNodeByName(model.pool, name)) {
                // Names are how the user identifies a node across views and
                // planes, so a second node with the same name is never what was
                // meant. The existing node is not touched — a node joins a plane
                // through + Add, deliberately, and only ever there.
                setStatus('A node called "' + name + '" already exists — nodes are ' +
                    'project-wide. Put it in a plane with + Add in Edit Plane.', 'warning');
                return;
            }
            var node = model.addNode(name);
            markDirty();
            if (nodeInput) nodeInput.value = '';
            setStatus('Created node "' + node.name + '" in the project pool — it is in ' +
                'no plane yet; add it to one with + Add in Edit Plane');
            refreshPlanePanel();
            redraw();
        });
    }
    if (nodeInput) {
        nodeInput.addEventListener('keydown', function (e) {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                if (addNodeBtn) addNodeBtn.click();
            }
        });
    }

    // --- Add an EXISTING pool node to the selected plane ---
    // The replacement for the old per-row "In" checkbox, and the primary way a
    // node comes to be shared between two planes.
    var addExistingBtn = document.getElementById('btnAddExistingPlaneNode');
    if (addExistingBtn) {
        addExistingBtn.addEventListener('click', function () {
            var plane = getSelectedPlane();
            if (!plane) { setStatus('No plane selected', 'warning'); return; }
            var select = document.getElementById('planeAddNodeSelect');
            var id = select ? parseInt(select.value, 10) : NaN;
            var model = planeModel();
            var node = isNaN(id) ? null : model.pool.getNode(id);
            if (!node) {
                setStatus('Pick a node to add — create one with + Node if there are none',
                    'warning');
                return;
            }
            if (!model.addNodeToPlane(plane, node.id, { viewBounds: viewBounds })) {
                setStatus('"' + node.name + '" is already in "' + plane.name + '"', 'warning');
                return;
            }
            var shared = model.planesForNode(node.id).length - 1;
            setStatus('Added "' + node.name + '" to "' + plane.name + '"' +
                (shared > 0
                    ? ' — it is now shared with ' + shared + ' other plane(s), so they ' +
                      'meet at that corner'
                    : ''), 'success');
            markDirty();
            syncPlanes3D();
            refreshPlanePanel();
            redraw();
        });
    }

    var addEdgeBtn = document.getElementById('btnAddPlaneEdge');
    if (addEdgeBtn) {
        addEdgeBtn.addEventListener('click', function () {
            var plane = getSelectedPlane();
            if (!plane) { setStatus('No plane selected', 'warning'); return; }
            var srcEl = document.getElementById('planeEdgeSrcSelect');
            var dstEl = document.getElementById('planeEdgeDstSelect');
            var src = srcEl ? parseInt(srcEl.value, 10) : NaN;
            var dst = dstEl ? parseInt(dstEl.value, 10) : NaN;
            if (isNaN(src) || isNaN(dst)) {
                setStatus('Add at least two nodes first', 'warning');
                return;
            }
            if (!plane.addEdge(src, dst)) {
                setStatus('Cannot connect: duplicate or same node', 'warning');
                return;
            }
            markDirty();
            syncPlanes3D();
            refreshPlanePanel();
            redraw();
        });
    }

    var newPlaneBtn = document.getElementById('btnNewPlaneSkeleton');
    if (newPlaneBtn) {
        newPlaneBtn.addEventListener('click', function () {
            createPlane();
            refreshPlanePanel();
        });
    }

    // --- Shared action row: acts on the SELECTED plane ---
    var triBtn = document.getElementById('btnPlaneTriangulate');
    if (triBtn) {
        triBtn.innerHTML = ICON_TRIANGULATE + '<span>Triangulate</span>';
        triBtn.addEventListener('click', function () {
            var plane = getSelectedPlane();
            if (!plane) return;
            triangulatePlaneAndReport(plane);
        });
    }

    var fillBtn = document.getElementById('btnPlaneFill');
    if (fillBtn) {
        fillBtn.innerHTML = ICON_MESH + '<span>Fill</span>';
        fillBtn.addEventListener('click', function () {
            var plane = getSelectedPlane();
            if (!plane) return;
            if (plane.nodeIds.length < 3) {
                setStatus('A polygon needs 3+ nodes to fill', 'warning');
                return;
            }
            plane.filled = !plane.filled;
            markDirty();
            syncPlanes3D();          // the 3D fill mirrors the 2D one
            refreshPlanePanel();
            redraw();
        });
    }

    var fitBtn = document.getElementById('btnPlaneFit');
    if (fitBtn) {
        fitBtn.innerHTML = ICON_FIT + '<span>Fit</span>';
        fitBtn.addEventListener('click', function () {
            var plane = getSelectedPlane();
            if (!plane) return;
            fitPlaneAndReport(plane);
        });
    }

    // Shared appearance sliders. One node size and one edge weight for EVERY
    // plane: these are reference geometry you size once for legibility against
    // your video, not per-plane styling.
    wirePlaneSlider('planeNodeSize', 'planeNodeSizeVal', 'nodeSize');
    wirePlaneSlider('planeEdgeWeight', 'planeEdgeWeightVal', 'edgeWidth');
    // 3D-only, so it re-pushes the scene instead of redrawing the canvases.
    wirePlaneSlider('planeNodeSize3d', 'planeNodeSize3dVal', 'nodeSize3d', syncPlanes3D);

    var originBtn = document.getElementById('btnSetOrigin');
    if (originBtn) originBtn.addEventListener('click', enterOriginMode);
    setupOriginDefinition();

    setupDockDropTarget();
}

/**
 * The next `pN` name no pool node is using.
 *
 * Pool-wide rather than per-plane (which is what it counted when `+ Node` still
 * added to a plane): names identify a node across every plane, so numbering
 * from one plane's length would hand out `p1` again as soon as a second plane
 * was started — and the duplicate-name guard would then refuse the click.
 * @private
 */
function nextFreeNodeName(pool) {
    var n = pool.size + 1;
    while (findNodeByName(pool, 'p' + n)) n++;
    return 'p' + n;
}

/** The pool node with this name, or null. @private */
function findNodeByName(pool, name) {
    for (var i = 0; i < pool.nodes.length; i++) {
        if (pool.nodes[i].name === name) return pool.nodes[i];
    }
    return null;
}

/** Bind a range input to a `planeState` field, with a live numeric readout. */
function wirePlaneSlider(inputId, valueId, stateKey, apply) {
    var input = document.getElementById(inputId);
    if (!input) return;
    var out = document.getElementById(valueId);
    // Seed from the markup so the default lives in one place (the HTML).
    var initial = parseInt(input.value, 10);
    if (!isNaN(initial)) planeState[stateKey] = initial;
    if (out) out.textContent = String(planeState[stateKey]);

    input.addEventListener('input', function () {
        var v = parseInt(input.value, 10);
        if (isNaN(v)) return;
        planeState[stateKey] = v;
        if (out) out.textContent = String(v);
        (apply || redraw)();
    });
}
