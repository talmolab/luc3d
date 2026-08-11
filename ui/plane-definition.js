// ui/plane-definition.js — "Defining Plane Mode" (View ▸ Define Planes)
//
// Step 1 of re-defining the 3D viewer's origin. The end goal is a translation
// vector + rotation matrix that move the world frame onto a plane the user
// annotates; this module is the ANNOTATION UI and owns nothing about the solve.
//
// The data model lives in `pose/plane-data.js` (`PlaneSkeleton`,
// `PlaneInstance`); this module owns the mode, the panel, drag-and-drop, and
// the overlay pass. What lives here:
//   - `planeState`   — mode flag, the project's plane-skeleton templates, and
//                      which one the editor is editing.
//   - Mode enter/exit — shows the "Defining Plane Mode" banner and swaps the
//                      info panel's tab bar for the Define Plane panel.
//   - The Define Plane panel — name + collapsible Nodes (with a per-node
//                      colour picker) / Node Connections editors, the
//                      plane-skeleton table, and the placement list.
//   - Drag-and-drop  — dragging a plane-skeleton row onto a video view places
//                      a `PlaneInstance`: a per-view, frame-independent set of
//                      2D points seeded in a ring around the drop point.
//   - `drawPlaneOverlays` — draws placements on a view's overlay canvas.
//                      Called by `drawAllOverlays` AFTER `drawFrameOverlays`,
//                      which clears the canvas.
//   - `installPlaneInteraction` — hands `ui/interaction.js` the callbacks it
//                      needs to hit-test / drag / select plane nodes.
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
// corner is defined by the plane and its views are just where it lands.
//
// Deliberately NOT here yet (later steps): triangulating a placement into a 3D
// plane, solving that plane into a translation + rotation, and persisting any
// of it into the `.slp`. Because nothing is persisted yet, placements do NOT
// call `markDirty()` — flagging a project dirty for state a save would
// silently drop is worse than losing it.
//
// The drag payload uses a private MIME type (`PLANE_DRAG_MIME`) and never sets
// `text/plain`. That is load-bearing: `ui/sessions-panes.js` tells dockview to
// accept any `text/plain` drag over the dock and turn it into a new video
// panel, so a plain-text payload here would be swallowed as a bogus view name.

import {
    PlaneSkeleton, PlaneInstance, seedPlanePoints, planePolygonOrder,
} from '../pose/plane-data.js';
import { hasPoint3d, getPoint3d, setPoint3d } from '../pose/pose-data.js';
import { state, interactionManager, viewport3d } from './app-state.js';
import { makeVideoToCanvasTransform } from './overlays.js';
import { setStatus } from '../import-export/save-load.js';
// Circular (rendering.js imports `drawPlaneOverlays` from here, and
// triangulation.js imports rendering.js). Safe because every use below is
// inside a function body, so the binding is resolved at call time rather than
// at module evaluation.
import { drawAllOverlays } from './rendering.js';
import {
    triangulatePoints, reprojectPointCamera,
    fitPlaneToPoints3d, projectPoints3dOntoPlane,
} from '../pose/triangulation.js';
// Circular (origin-definition imports `planeState` / `syncPlanes3D` back).
// Same rule as the rendering.js cycle above: call-time use only.
import {
    enterOriginMode, exitOriginMode, isOriginModeActive, attachOriginCallbacks,
    setupOriginDefinition, renderOriginResult, fittedPlanes,
} from './origin-definition.js';

// Re-exported so callers (and tests) can reach the model through the feature
// module without knowing it was split out.
export { PlaneSkeleton, PlaneInstance, seedPlanePoints, planePolygonOrder };

// Private drag MIME. See the module note above — must NOT be `text/plain`.
export const PLANE_DRAG_MIME = 'application/x-lucid-plane-skeleton';

export const planeState = {
    /** @type {boolean} True while Defining Plane Mode is active. */
    active: false,
    /** @type {PlaneSkeleton[]} Project-scoped templates (app-session memory). */
    skeletons: [],
    /** @type {number|null} `PlaneSkeleton.id` the editor is editing. */
    selectedSkeletonId: null,
    /**
     * @type {number} Node radius in canvas px, SHARED by every plane. One
     * value rather than per-skeleton: these are reference geometry you size
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
    /** @type {Set<number>} Skeleton ids whose placement list is expanded. */
    expanded: new Set(),
    _nextSkeletonId: 1,
    _nextPlacementId: 1,
};

export function getPlaneSkeleton(id) {
    for (var i = 0; i < planeState.skeletons.length; i++) {
        if (planeState.skeletons[i].id === id) return planeState.skeletons[i];
    }
    return null;
}

/** The skeleton the editor is currently editing, or null. */
export function getSelectedPlaneSkeleton() {
    return planeState.selectedSkeletonId == null
        ? null
        : getPlaneSkeleton(planeState.selectedSkeletonId);
}

/** The skeleton a placed instance came from, or null. */
export function getSkeletonFor(planeInstance) {
    return planeInstance ? getPlaneSkeleton(planeInstance.skeletonId) : null;
}

/** Create a new plane skeleton, select it for editing, and return it. */
export function createPlaneSkeleton(name) {
    var id = planeState._nextSkeletonId++;
    var sk = new PlaneSkeleton(id, name || ('plane_' + id));
    planeState.skeletons.push(sk);
    planeState.selectedSkeletonId = id;
    return sk;
}

/**
 * Delete a plane skeleton AND every placement made from it — a placement's
 * points are indexed by the skeleton's node list, so an orphan would draw
 * against a template that no longer exists.
 */
export function deletePlaneSkeleton(id) {
    var idx = -1;
    for (var i = 0; i < planeState.skeletons.length; i++) {
        if (planeState.skeletons[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return false;
    planeState.skeletons.splice(idx, 1);

    var byView = getPlacementMap(false);
    if (byView) {
        byView.forEach(function (list, viewName) {
            byView.set(viewName, list.filter(function (p) { return p.skeletonId !== id; }));
        });
    }
    clearSelectionIfGone();
    if (planeState.selectedSkeletonId === id) {
        planeState.selectedSkeletonId = planeState.skeletons.length
            ? planeState.skeletons[0].id
            : null;
    }
    syncPlanes3D();
    return true;
}

// ============================================
// Placements (per session, per view, frame-independent)
// ============================================

/**
 * The active session's `viewName -> PlaneInstance[]` map. A plane is static
 * scene geometry, so placements are deliberately NOT keyed by frame.
 * @param {boolean} [create=true] Create the map if the session lacks one.
 * @returns {Map<string, PlaneInstance[]>|null}
 */
function getPlacementMap(create) {
    var session = state.session;
    if (!session) return null;
    if (!session.planePlacements) {
        if (create === false) return null;
        session.planePlacements = new Map();
    }
    return session.planePlacements;
}

/** Placements on `viewName` in the active session (empty array if none). */
export function getPlacements(viewName) {
    var byView = getPlacementMap(false);
    if (!byView) return [];
    return byView.get(viewName) || [];
}

/** Every placement in the active session, flattened. */
export function getAllPlacements() {
    var byView = getPlacementMap(false);
    if (!byView) return [];
    var out = [];
    byView.forEach(function (list) {
        for (var i = 0; i < list.length; i++) out.push(list[i]);
    });
    return out;
}

/** The placement of `skeletonId` on `viewName`, or null. */
export function getPlacementOn(viewName, skeletonId) {
    var list = getPlacements(viewName);
    for (var i = 0; i < list.length; i++) {
        if (list[i].skeletonId === skeletonId) return list[i];
    }
    return null;
}

/**
 * Place `skeleton` on `viewName` centred at (cx, cy) in video pixels.
 *
 * ONE PLACEMENT PER VIEW PER SKELETON: a second drop of the same plane on the
 * same view is refused rather than stacking or silently re-seeding, so
 * carefully positioned nodes can't be destroyed by a stray drag. Delete the
 * placement first to redo it.
 *
 * @returns {PlaneInstance|null} null if refused or the view is unavailable.
 */
export function addPlacement(skeleton, viewName, cx, cy) {
    var byView = getPlacementMap(true);
    if (!byView || !skeleton) return null;
    var view = findView(viewName);
    if (!view) return null;
    if (getPlacementOn(viewName, skeleton.id)) return null;

    var placement = new PlaneInstance(
        planeState._nextPlacementId++, skeleton.id, viewName,
        seedPlanePoints(skeleton.nodes.length, cx, cy,
            view.videoWidth || 0, view.videoHeight || 0)
    );
    if (!byView.has(viewName)) byView.set(viewName, []);
    byView.get(viewName).push(placement);
    return placement;
}

/** Remove a placement by id. @returns {boolean} */
export function removePlacement(placementId) {
    var byView = getPlacementMap(false);
    if (!byView) return false;
    var removed = false;
    var skeletonId = null;
    byView.forEach(function (list, viewName) {
        var kept = list.filter(function (p) {
            if (p.id === placementId) skeletonId = p.skeletonId;
            return p.id !== placementId;
        });
        if (kept.length !== list.length) {
            byView.set(viewName, kept);
            removed = true;
        }
    });
    if (removed) {
        // The 3D was solved from a view set that no longer holds.
        var sk = getPlaneSkeleton(skeletonId);
        if (sk) sk.clearTriangulation();
        clearSelectionIfGone();
        syncPlanes3D();
    }
    return removed;
}

/**
 * Drop the interaction manager's plane selection if the selected placement is
 * no longer in the session — a dangling selection would keep a deleted plane
 * highlighted and reachable by keyboard.
 */
function clearSelectionIfGone() {
    if (!interactionManager || !interactionManager.selectedPlane) return;
    var all = getAllPlacements();
    if (all.indexOf(interactionManager.selectedPlane) < 0) {
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
 * Keep every placement of `skeleton` the same length as its node list after a
 * node was added. New nodes get a real position near the placement's centroid
 * (see `PlaneInstance.syncToNodeCount`) rather than being left unpositioned —
 * an unpositioned node draws nothing, so the user would have no way to grab it.
 */
function syncPlacementsToSkeleton(skeleton) {
    var byView = getPlacementMap(false);
    if (!byView || !skeleton) return;
    byView.forEach(function (list, viewName) {
        var view = findView(viewName);
        for (var i = 0; i < list.length; i++) {
            if (list[i].skeletonId !== skeleton.id) continue;
            list[i].syncToNodeCount(skeleton.nodes.length,
                view ? view.videoWidth : 0, view ? view.videoHeight : 0);
        }
    });
}

/**
 * Drop the point at `nodeIdx` from every placement of `skeleton`, mirroring
 * `PlaneSkeleton.removeNode`'s splice so the remaining points stay aligned
 * with the shifted-down node indices.
 */
function removeNodeFromPlacements(skeleton, nodeIdx) {
    var byView = getPlacementMap(false);
    if (!byView || !skeleton) return;
    byView.forEach(function (list) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].skeletonId !== skeleton.id) continue;
            list[i].removeNodeAt(nodeIdx);
        }
    });
}

// ============================================
// Triangulation
// ============================================

/**
 * Triangulate a plane skeleton across every view it is placed on.
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
 * DLT only (no BA option yet): a plane is 3-8 hand-placed corners, so the
 * linear solve is instant and the non-linear refinement has little to work
 * with. Revisit if the reprojection errors turn out to warrant it.
 *
 * @param {PlaneSkeleton} skeleton
 * @returns {{ok:boolean, reason?:string, views?:string[], nNodes?:number,
 *             meanError?:number|null}} Result summary; `ok:false` carries a
 *   human-readable `reason` that the caller shows in the status bar.
 */
export function triangulatePlane(skeleton) {
    if (!skeleton) return { ok: false, reason: 'No plane skeleton' };
    var session = state.session;
    if (!session || !session.cameras || session.cameras.length < 2) {
        return { ok: false, reason: 'Load calibration for 2+ cameras first' };
    }
    if (!skeleton.nodes.length) {
        return { ok: false, reason: 'Plane "' + skeleton.name + '" has no nodes' };
    }

    // The views this plane is actually placed on, in camera order.
    var contributors = [];
    for (var c = 0; c < session.cameras.length; c++) {
        var cam = session.cameras[c];
        var placement = getPlacementOn(cam.name, skeleton.id);
        if (placement) contributors.push({ cam: cam, placement: placement });
    }
    if (contributors.length < 2) {
        return {
            ok: false,
            reason: '"' + skeleton.name + '" is placed on ' + contributors.length +
                ' view' + (contributors.length === 1 ? '' : 's') + ' — needs 2+',
        };
    }

    var projMatrices = contributors.map(function (v) { return v.cam.projectionMatrix; });
    var nNodes = skeleton.nodes.length;

    // allObs[k][c] undistorted (for DLT); allRaw[k][c] native (for error).
    var allObs = [];
    var allRaw = [];
    for (var k = 0; k < nNodes; k++) {
        var obs = [];
        var raw = [];
        for (var vi = 0; vi < contributors.length; vi++) {
            var p = contributors[vi].placement;
            var camv = contributors[vi].cam;
            if (p.hasPoint(k) && !p.isNodeNulled(k)) {
                var r = p.getPoint(k);
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

    var points3d = triangulatePoints(allObs, projMatrices);

    // Per-node reprojection error, averaged over the views that contributed.
    var nodeErrors = [];
    var errSum = 0, errCount = 0, solved = 0;
    for (var n2 = 0; n2 < nNodes; n2++) {
        if (!hasPoint3d(points3d, n2)) { nodeErrors.push(null); continue; }
        solved++;
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
        var nodeErr = cnt > 0 ? sum / cnt : null;
        nodeErrors.push(nodeErr);
        if (nodeErr != null) { errSum += nodeErr; errCount++; }
    }

    if (solved === 0) {
        skeleton.clearTriangulation();
        return {
            ok: false,
            reason: 'No node of "' + skeleton.name + '" is placed (and enabled) in 2+ views',
        };
    }

    var viewNames = contributors.map(function (v) { return v.cam.name; });
    skeleton.points3d = points3d;
    skeleton.triangulation = {
        views: viewNames,
        nNodes: solved,
        meanError: errCount > 0 ? errSum / errCount : null,
        nodeErrors: nodeErrors,
    };
    return {
        ok: true,
        views: viewNames,
        nNodes: solved,
        meanError: skeleton.triangulation.meanError,
    };
}

/** Triangulate + push to the 3D viewer + report + refresh the panel. */
function triangulatePlaneAndReport(skeleton) {
    var res = triangulatePlane(skeleton);
    if (!res.ok) {
        setStatus(res.reason, 'warning');
    } else {
        // Expand the row so the freshly computed 3D is visible, not silent.
        planeState.expanded.add(skeleton.id);
        setStatus('Triangulated "' + skeleton.name + '": ' + res.nNodes + '/' +
            skeleton.nodes.length + ' nodes from ' + res.views.length + ' views' +
            (res.meanError != null ? ' — mean error ' + res.meanError.toFixed(2) + ' px' : ''),
            'success');
    }
    syncPlanes3D();
    refreshPlanePanel();
    return res;
}

/**
 * Fit a plane of best fit to a skeleton's triangulated corners, flatten the
 * corners onto it, and push the correction back out to BOTH representations:
 * the 3D viewer and every 2D view the plane is placed on.
 *
 * This is the second half of the origin pipeline. Triangulated corners are
 * never exactly coplanar (each carries independent reprojection error), but the
 * thing we ultimately want a translation + rotation from IS a plane — so the
 * fit is what turns a cloud of four nearly-coplanar points into an actual
 * plane, and writing the flattened points back is what makes the annotation
 * agree with it. Leaving the 2D showing the unflattened corners would mean the
 * displayed annotation and the geometry we solve from silently disagree.
 *
 * The 2D write-back reprojects through `reprojectPointCamera`, which applies
 * lens distortion — annotations live in the camera's NATIVE pixel space, so
 * the ideal-pinhole `Camera.project` would drift outward near the frame edges.
 *
 * Nodes toggled off in a view still get their 2D updated there: "off" means
 * "don't use this observation in the solve", not "this corner isn't on the
 * plane", and leaving it stale would distort the drawn polygon. The off flags
 * themselves are preserved.
 *
 * @param {PlaneSkeleton} skeleton
 * @returns {{ok:boolean, reason?:string, rms?:number, nPoints?:number,
 *            movedPx?:number}} `rms` is the pre-fit RMS deviation from the
 *   fitted plane (how non-planar the annotation was); `movedPx` is the mean 2D
 *   distance the corrected corners travelled.
 */
export function fitPlane(skeleton) {
    if (!skeleton) return { ok: false, reason: 'No plane skeleton' };

    // Fit needs 3D. Solve it first rather than making the user click twice.
    if (!skeleton.points3d) {
        var tri = triangulatePlane(skeleton);
        if (!tri.ok) return { ok: false, reason: tri.reason };
    }

    var plane = fitPlaneToPoints3d(skeleton.points3d);
    if (!plane) {
        return {
            ok: false,
            reason: '"' + skeleton.name + '" needs 3+ non-collinear triangulated nodes to fit a plane',
        };
    }

    var flattened = projectPoints3dOntoPlane(skeleton.points3d, plane);
    skeleton.points3d = flattened;
    skeleton.planeFit = {
        centroid: plane.centroid,
        normal: plane.normal,
        rms: plane.rms,
        nPoints: plane.nPoints,
    };

    // Push the corrected corners back into every 2D view this plane is on.
    var session = state.session;
    var movedSum = 0, movedCount = 0;
    if (session && session.cameras) {
        for (var c = 0; c < session.cameras.length; c++) {
            var cam = session.cameras[c];
            var placement = getPlacementOn(cam.name, skeleton.id);
            if (!placement) continue;
            for (var k = 0; k < placement.numNodes; k++) {
                if (!hasPoint3d(flattened, k)) continue;
                var uv = reprojectPointCamera(getPoint3d(flattened, k), cam);
                if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) continue;
                if (placement.hasPoint(k)) {
                    var dx = uv[0] - placement.getX(k);
                    var dy = uv[1] - placement.getY(k);
                    movedSum += Math.sqrt(dx * dx + dy * dy);
                    movedCount++;
                }
                placement.setPoint(k, uv[0], uv[1]);
            }
            placement.modified = true;
        }
    }

    // The 3D is now the FITTED plane and the 2D matches it, so the stored
    // triangulation summary is no longer the whole story — re-derive the
    // reprojection errors against the flattened points so the panel reports
    // what is actually on screen.
    refreshTriangulationErrors(skeleton);

    return {
        ok: true,
        rms: plane.rms,
        nPoints: plane.nPoints,
        movedPx: movedCount > 0 ? movedSum / movedCount : 0,
    };
}

/**
 * Recompute `skeleton.triangulation`'s per-node + mean reprojection error
 * against the CURRENT `points3d` and the CURRENT 2D. Used after a fit, where
 * the 3D moved but the view set did not.
 */
function refreshTriangulationErrors(skeleton) {
    var t = skeleton.triangulation;
    var session = state.session;
    if (!t || !session || !session.cameras || !skeleton.points3d) return;

    var contributors = [];
    for (var c = 0; c < session.cameras.length; c++) {
        var cam = session.cameras[c];
        if (t.views.indexOf(cam.name) < 0) continue;
        var placement = getPlacementOn(cam.name, skeleton.id);
        if (placement) contributors.push({ cam: cam, placement: placement });
    }

    var nodeErrors = [];
    var sum = 0, count = 0;
    for (var k = 0; k < skeleton.nodes.length; k++) {
        if (!hasPoint3d(skeleton.points3d, k)) { nodeErrors.push(null); continue; }
        var pt = getPoint3d(skeleton.points3d, k);
        var s = 0, n = 0;
        for (var v = 0; v < contributors.length; v++) {
            var p = contributors[v].placement;
            if (!p.hasPoint(k) || p.isNodeNulled(k)) continue;
            var rp = reprojectPointCamera(pt, contributors[v].cam);
            if (!rp) continue;
            var dx = rp[0] - p.getX(k);
            var dy = rp[1] - p.getY(k);
            s += Math.sqrt(dx * dx + dy * dy);
            n++;
        }
        var e = n > 0 ? s / n : null;
        nodeErrors.push(e);
        if (e != null) { sum += e; count++; }
    }
    t.nodeErrors = nodeErrors;
    t.meanError = count > 0 ? sum / count : null;
}

/** Fit + report + refresh both representations. */
function fitPlaneAndReport(skeleton) {
    var res = fitPlane(skeleton);
    if (!res.ok) {
        setStatus(res.reason, 'warning');
    } else {
        planeState.expanded.add(skeleton.id);
        setStatus('Fitted plane to "' + skeleton.name + '": ' + res.nPoints +
            ' points were ' + res.rms.toFixed(2) + ' mm RMS off-plane; corners moved ' +
            res.movedPx.toFixed(1) + ' px in 2D', 'success');
    }
    syncPlanes3D();
    refreshPlanePanel();
    redraw();
    return res;
}

/**
 * Push every triangulated plane into the 3D viewport.
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

    var payload = [];
    for (var i = 0; i < planeState.skeletons.length; i++) {
        var sk = planeState.skeletons[i];
        if (!sk.points3d) continue;
        payload.push({
            id: sk.id,
            name: sk.name,
            color: sk.color,
            nodeColors: sk.nodeColors,
            edges: sk.edges,
            polygonOrder: planePolygonOrder(sk),
            filled: sk.filled,
            // Corners are draggable in 3D only once the plane has been FIT —
            // the fit is what supplies the surface a corner is allowed to slide
            // along. Gated on the mode too, matching 2D: outside Defining Plane
            // Mode a plane is visible but inert in both representations.
            // Set Origin Mode also turns dragging off — a corner must not move
            // out from under the click that is selecting it as the origin.
            editable: planeState.active && !isOriginModeActive() && !!sk.planeFit,
            planeFit: sk.planeFit,
            points3d: sk.points3d,
        });
    }
    viewport3d.setPlanes(payload);
}

// ============================================
// Dragging a plane corner in the 3D viewport
// ============================================

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
 * `skeleton.planeFit` is deliberately NOT re-derived. Centroid + normal are
 * what a later step turns into the origin's translation + rotation; a corner
 * nudge must not move the frame it defines.
 *
 * @param {number} skeletonId
 * @param {number} nodeIdx
 * @param {number[]} xyz - already on the fitted plane
 */
function onPlaneNodeDragged3D(skeletonId, nodeIdx, xyz) {
    var sk = getPlaneSkeleton(skeletonId);
    if (!sk || !sk.planeFit || !sk.points3d) return;
    if (!(nodeIdx >= 0) || nodeIdx >= sk.nodes.length) return;
    if (!xyz || !isFinite(xyz[0]) || !isFinite(xyz[1]) || !isFinite(xyz[2])) return;

    setPoint3d(sk.points3d, nodeIdx, xyz);

    var session = state.session;
    if (session && session.cameras) {
        for (var c = 0; c < session.cameras.length; c++) {
            var cam = session.cameras[c];
            var placement = getPlacementOn(cam.name, sk.id);
            if (!placement || nodeIdx >= placement.numNodes) continue;
            var uv = reprojectPointCamera(xyz, cam);
            if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) continue;
            placement.setPoint(nodeIdx, uv[0], uv[1]);
            placement.modified = true;
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
function onPlaneNodeDragEnd3D(skeletonId, nodeIdx) {
    var sk = getPlaneSkeleton(skeletonId);
    if (!sk) return;
    // The 2D was written to the exact reprojection of the moved 3D, so the
    // stored per-node errors are stale — re-derive them against what is now on
    // screen rather than leaving the panel reporting the pre-drag numbers.
    refreshTriangulationErrors(sk);
    refreshPlanePanel();
    var nodeName = sk.nodes[nodeIdx] || ('node ' + nodeIdx);
    setStatus('Moved "' + nodeName + '" on plane "' + sk.name +
        '" — it stays on the fitted plane');
}

// ============================================
// Mode enter / exit
// ============================================

export function isPlaneModeActive() {
    return planeState.active;
}

export function enterPlaneMode() {
    if (planeState.active) return;
    planeState.active = true;

    var bar = document.getElementById('planeModeBar');
    if (bar) bar.style.display = '';

    setPanelPlaneMode(true);

    // Start with something to edit so the panel is never a dead end.
    if (!planeState.skeletons.length) createPlaneSkeleton();
    else if (planeState.selectedSkeletonId == null) {
        planeState.selectedSkeletonId = planeState.skeletons[0].id;
    }

    refreshPlanePanel();
    redraw();
    // The mode gates 3D corner dragging as well as 2D, so the scene has to be
    // re-pushed for the `editable` flag to flip.
    syncPlanes3D();
    setStatus('Defining Plane Mode — drag a plane skeleton onto a video view', 'success');
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
    renderSkeletonsTable();
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

// --- Editor: name + nodes + node connections -------------------------------

function renderEditor() {
    var sk = getSelectedPlaneSkeleton();

    var nameInput = document.getElementById('planeSkeletonName');
    if (nameInput) {
        nameInput.value = sk ? sk.name : '';
        nameInput.disabled = !sk;
    }

    renderEditorNodes(sk);
    renderEditorEdges(sk);
}

function renderEditorNodes(sk) {
    var tbody = document.querySelector('#planeNodesTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    var nodes = sk ? sk.nodes : [];
    setEmptyState('planeNodesTable', 'planeNodesEmpty', nodes.length === 0);

    nodes.forEach(function (name, i) {
        var tr = document.createElement('tr');

        var tdIdx = document.createElement('td');
        tdIdx.className = 'mono';
        tdIdx.textContent = String(i);

        var tdName = document.createElement('td');
        var input = document.createElement('input');
        input.type = 'text';
        input.value = name;
        input.className = 'plane-text-input';
        input.style.width = '100%';
        input.addEventListener('change', function () {
            var newName = input.value.trim();
            if (!newName) { input.value = sk.nodes[i]; return; }
            sk.nodes[i] = newName;
            refreshPlanePanel();
            redraw();
        });
        tdName.appendChild(input);

        // Per-node colour. Scoped to the SKELETON, so this node is the same
        // colour on every view and every placement — that is the cross-view
        // correspondence cue you check before triangulating.
        var tdColor = document.createElement('td');
        var color = document.createElement('input');
        color.type = 'color';
        color.className = 'plane-node-color';
        color.value = sk.getNodeColor(i);
        color.title = 'Colour for node "' + name + '" on every view';
        color.addEventListener('input', function () {
            sk.setNodeColor(i, color.value);
            redraw();
        });
        color.addEventListener('change', function () {
            sk.setNodeColor(i, color.value);
            refreshPlanePanel();
            redraw();
        });
        color.addEventListener('click', function (e) { e.stopPropagation(); });
        tdColor.appendChild(color);

        var tdDel = document.createElement('td');
        tdDel.appendChild(makeDeleteButton('Remove node', function () {
            // Order matters: splice the placements' points at the OLD index
            // before the skeleton renumbers its nodes.
            removeNodeFromPlacements(sk, i);
            sk.removeNode(i);
            refreshPlanePanel();
            redraw();
        }));

        tr.appendChild(tdIdx);
        tr.appendChild(tdName);
        tr.appendChild(tdColor);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
    });

    // Node connection dropdowns follow the node list.
    var srcSelect = document.getElementById('planeEdgeSrcSelect');
    var dstSelect = document.getElementById('planeEdgeDstSelect');
    if (srcSelect) srcSelect.textContent = '';
    if (dstSelect) dstSelect.textContent = '';
    nodes.forEach(function (name, i) {
        if (srcSelect) {
            var o1 = document.createElement('option');
            o1.value = String(i);
            o1.textContent = name;
            srcSelect.appendChild(o1);
        }
        if (dstSelect) {
            var o2 = document.createElement('option');
            o2.value = String(i);
            o2.textContent = name;
            dstSelect.appendChild(o2);
        }
    });
    // Default the destination to the second node so the common
    // "connect the next one" case is one click.
    if (dstSelect && nodes.length > 1) dstSelect.value = '1';
}

function renderEditorEdges(sk) {
    var tbody = document.querySelector('#planeEdgesTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    var edges = sk ? sk.edges : [];
    setEmptyState('planeEdgesTable', 'planeEdgesEmpty', edges.length === 0);

    edges.forEach(function (edge, edgeIdx) {
        var tr = document.createElement('tr');

        var tdSrc = document.createElement('td');
        tdSrc.textContent = sk.nodes[edge[0]];
        var tdDst = document.createElement('td');
        tdDst.textContent = sk.nodes[edge[1]];

        var tdDel = document.createElement('td');
        tdDel.appendChild(makeDeleteButton('Remove connection', function () {
            sk.removeEdge(edgeIdx);
            refreshPlanePanel();
            redraw();
        }));

        tr.appendChild(tdSrc);
        tr.appendChild(tdDst);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
    });
}

// --- Plane skeleton table (drag source) ------------------------------------

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

function makeIconButton(html, title, extraClass, onClick) {
    var btn = document.createElement('button');
    btn.className = 'panel-btn plane-icon-btn' + (extraClass ? ' ' + extraClass : '');
    btn.innerHTML = html;
    btn.title = title;
    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        onClick();
    });
    return btn;
}

/**
 * Enable/disable + relabel the shared Triangulate / Fill / Fit row.
 *
 * All three act on the SELECTED plane skeleton, so they are disabled outright
 * when nothing is selected. When something IS selected they stay enabled even
 * if the action's precondition fails (too few views, too few nodes) — clicking
 * then reports WHY in the status bar, which teaches more than a dead button.
 */
function renderActionRow() {
    var sk = getSelectedPlaneSkeleton();
    var triBtn = document.getElementById('btnPlaneTriangulate');
    var fillBtn = document.getElementById('btnPlaneFill');
    var fitBtn = document.getElementById('btnPlaneFit');
    if (!triBtn || !fillBtn || !fitBtn) return;

    [triBtn, fillBtn, fitBtn].forEach(function (b) { b.disabled = !sk; });
    if (!sk) {
        triBtn.title = fillBtn.title = fitBtn.title = 'Select a plane skeleton first';
        triBtn.classList.remove('active');
        fillBtn.classList.remove('active');
        fitBtn.classList.remove('active');
        fillBtn.style.color = '';
        return;
    }

    var nPlaced = placementsOf(sk.id).length;

    triBtn.classList.toggle('active', !!sk.triangulation);
    triBtn.title = sk.triangulation
        ? 'Re-triangulate "' + sk.name + '" (currently ' + sk.triangulation.nNodes +
          ' node(s) from ' + sk.triangulation.views.join(', ') + ')'
        : 'Triangulate "' + sk.name + '" across the ' + nPlaced +
          ' view(s) it is placed on, and show it in the 3D viewer';

    fillBtn.classList.toggle('active', !!sk.filled);
    fillBtn.style.color = sk.filled ? sk.color : '';
    fillBtn.title = (sk.filled ? 'Unfill' : 'Fill') + ' the "' + sk.name +
        '" polygon with its colour';

    fitBtn.classList.toggle('active', !!sk.planeFit);
    fitBtn.title = 'Fit a plane of best fit to "' + sk.name + '" and flatten its ' +
        'points onto it, updating the 3D viewer and every 2D view' +
        (sk.planeFit ? ' (last fit moved points ' + sk.planeFit.rms.toFixed(2) + ' mm RMS)' : '');
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

function renderSkeletonsTable() {
    var tbody = document.querySelector('#planeSkeletonsTable tbody');
    if (!tbody) return;
    tbody.textContent = '';

    setEmptyState('planeSkeletonsTable', 'planeSkeletonsEmpty',
        planeState.skeletons.length === 0);

    planeState.skeletons.forEach(function (sk) {
        var placements = placementsOf(sk.id);
        var tr = document.createElement('tr');
        tr.setAttribute('data-plane-skeleton-id', String(sk.id));
        if (sk.id === planeState.selectedSkeletonId) tr.classList.add('plane-selected');

        // A skeleton with no nodes has nothing to draw, so make it undraggable
        // rather than letting a drop produce an invisible placement.
        var draggable = sk.nodes.length > 0;
        tr.draggable = draggable;
        tr.title = draggable
            ? 'Drag onto a video view to place; click to edit'
            : 'Add at least one node before placing this plane';

        // --- Expander: reveals where this plane is placed ---
        var expanded = planeState.expanded.has(sk.id);
        var tdExpand = document.createElement('td');
        var expandBtn = document.createElement('button');
        expandBtn.className = 'plane-expander' + (expanded ? ' open' : '');
        expandBtn.innerHTML = '<span class="plane-caret">▶</span>' +
            '<span class="plane-placed-count">' + placements.length + '</span>';
        expandBtn.title = placements.length
            ? (expanded ? 'Hide placements' : 'Show the ' + placements.length + ' placement(s)')
            : 'Not placed on any view yet';
        expandBtn.disabled = placements.length === 0;
        expandBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (planeState.expanded.has(sk.id)) planeState.expanded.delete(sk.id);
            else planeState.expanded.add(sk.id);
            refreshPlanePanel();
        });
        tdExpand.appendChild(expandBtn);

        var tdName = document.createElement('td');
        var swatch = document.createElement('span');
        swatch.className = 'plane-swatch';
        swatch.style.background = sk.color;
        tdName.appendChild(swatch);
        tdName.appendChild(document.createTextNode(sk.name));

        var tdNodes = document.createElement('td');
        tdNodes.className = 'mono';
        tdNodes.textContent = String(sk.nodes.length);

        // --- Actions: delete only. Triangulate / Fill / Fit moved to the
        // shared action row below the table, where they act on the SELECTED
        // skeleton rather than being repeated on every row.
        var tdActions = document.createElement('td');
        tdActions.className = 'plane-actions';

        // A solved plane is worth seeing at a glance without expanding.
        if (sk.triangulation) {
            var badge = document.createElement('span');
            badge.className = 'plane-solved-badge';
            badge.textContent = '3D';
            badge.title = sk.triangulation.nNodes + ' node(s) from ' +
                sk.triangulation.views.join(', ') +
                (sk.planeFit ? ' — fitted' : '');
            tdActions.appendChild(badge);
        }

        tdActions.appendChild(makeDeleteButton('Delete plane skeleton (and its placements)', function () {
            deletePlaneSkeleton(sk.id);
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
            planeState.selectedSkeletonId = sk.id;
            refreshPlanePanel();
        });

        tr.addEventListener('dragstart', function (e) {
            if (!draggable) { e.preventDefault(); return; }
            // Private MIME only — see the module note: a `text/plain` payload
            // would be grabbed by dockview's video-panel drop handler.
            e.dataTransfer.setData(PLANE_DRAG_MIME, String(sk.id));
            e.dataTransfer.effectAllowed = 'copy';
        });

        tr.appendChild(tdExpand);
        tr.appendChild(tdName);
        tr.appendChild(tdNodes);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);

        if (expanded && placements.length) {
            tbody.appendChild(buildPlacementsRow(sk, placements));
        }
    });
}

/** Placements of one skeleton, across every view. */
function placementsOf(skeletonId) {
    return getAllPlacements().filter(function (p) { return p.skeletonId === skeletonId; });
}

/**
 * The expanded sub-row for a skeleton: one line per view it is placed on
 * (click to select, × to remove), plus the triangulation readout when there is
 * one — a Triangulate button whose result you cannot see would be a dead end.
 */
function buildPlacementsRow(sk, placements) {
    var tr = document.createElement('tr');
    tr.className = 'plane-placements-row';
    tr.setAttribute('data-plane-placements-for', String(sk.id));

    var td = document.createElement('td');
    td.colSpan = 4;

    var selected = interactionManager ? interactionManager.selectedPlane : null;

    placements.forEach(function (p) {
        var row = document.createElement('div');
        row.className = 'plane-placement-item';
        row.setAttribute('data-plane-placement-id', String(p.id));
        if (p === selected) row.classList.add('plane-selected');

        var name = document.createElement('span');
        name.className = 'plane-placement-view';
        name.textContent = p.viewName;
        row.appendChild(name);

        var off = 0;
        for (var i = 0; i < p.numNodes; i++) if (p.isNodeNulled(i)) off++;
        var meta = document.createElement('span');
        meta.className = 'plane-placement-meta';
        meta.textContent = off ? off + ' off' : '';
        row.appendChild(meta);

        var del = makeDeleteButton('Remove this placement', function () {
            removePlacement(p.id);
            refreshPlanePanel();
            redraw();
        });
        row.appendChild(del);

        row.addEventListener('click', function () {
            if (interactionManager) interactionManager.selectPlane(p, -1);
            refreshPlanePanel();
            redraw();
        });
        td.appendChild(row);
    });

    if (sk.triangulation) {
        var t = sk.triangulation;
        var summary = document.createElement('div');
        summary.className = 'plane-tri-summary';
        summary.textContent = '3D: ' + t.nNodes + '/' + sk.nodes.length + ' nodes from ' +
            t.views.join(', ') +
            (t.meanError != null ? ' — mean err ' + t.meanError.toFixed(2) + ' px' : '');
        td.appendChild(summary);

        if (sk.planeFit) {
            var f = sk.planeFit;
            var fit = document.createElement('div');
            fit.className = 'plane-tri-summary plane-fit-summary';
            fit.textContent = 'Fitted plane — normal (' +
                f.normal.map(function (q) { return q.toFixed(3); }).join(', ') +
                '), was ' + f.rms.toFixed(2) + ' mm RMS off-plane';
            fit.title = 'Centroid (' +
                f.centroid.map(function (q) { return q.toFixed(1); }).join(', ') + ')';
            td.appendChild(fit);
        }

        for (var n = 0; n < sk.nodes.length; n++) {
            var line = document.createElement('div');
            line.className = 'plane-tri-node';
            var sw = document.createElement('span');
            sw.className = 'plane-swatch';
            sw.style.background = sk.getNodeColor(n);
            line.appendChild(sw);
            var text = sk.nodes[n] + '  ';
            if (sk.points3d && hasPoint3d(sk.points3d, n)) {
                var q = getPoint3d(sk.points3d, n);
                text += '(' + q[0].toFixed(1) + ', ' + q[1].toFixed(1) + ', ' + q[2].toFixed(1) + ')';
                if (t.nodeErrors[n] != null) text += '  ' + t.nodeErrors[n].toFixed(2) + ' px';
            } else {
                text += '—';
            }
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

        var skId = parseInt(e.dataTransfer.getData(PLANE_DRAG_MIME), 10);
        handlePlaneDrop(skId, viewName, e.clientX, e.clientY);
    });

    document.addEventListener('dragend', clearDropTargetHighlight);
}

/**
 * Place plane skeleton `skeletonId` on `viewName` at the drop point.
 * Exported for tests — the drop listener is only a thin adapter over this.
 */
export function handlePlaneDrop(skeletonId, viewName, clientX, clientY) {
    var sk = getPlaneSkeleton(skeletonId);
    if (!sk) { setStatus('Unknown plane skeleton', 'warning'); return null; }
    if (!sk.nodes.length) {
        setStatus('Plane "' + sk.name + '" has no nodes to place', 'warning');
        return null;
    }
    var view = findView(viewName);
    if (!view) { setStatus('No such view: ' + viewName, 'warning'); return null; }
    if (getPlacementOn(viewName, sk.id)) {
        setStatus('"' + sk.name + '" is already placed on ' + viewName +
            ' — remove that placement first', 'warning');
        return null;
    }

    // Reuse the interaction manager's transform so the drop lands where the
    // cursor is under zoom / pan / rotation, exactly like a click would.
    var vp = interactionManager
        ? interactionManager.canvasToVideo(clientX, clientY, viewName)
        : [(view.videoWidth || 0) / 2, (view.videoHeight || 0) / 2];

    var placement = addPlacement(sk, viewName, vp[0], vp[1]);
    if (!placement) { setStatus('Could not place plane', 'error'); return null; }

    if (interactionManager) interactionManager.selectPlane(placement, -1);
    refreshPlanePanel();
    redraw();
    setStatus('Placed "' + sk.name + '" on ' + viewName, 'success');
    return placement;
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
        getPlaneInstances: getPlacements,
        getPlaneEdges: function (planeInstance) {
            var sk = getSkeletonFor(planeInstance);
            return sk ? sk.edges : [];
        },
        // Hit radius follows the shared Node Size slider, so what you can grab
        // is always what you can see.
        getPlaneNodeSize: function () { return planeState.nodeSize; },
        onPlaneChanged: function (planeInstance) {
            // Moving a node (or toggling one off) invalidates any 3D solved
            // from the old 2D. Showing a stale solve against edited points is
            // exactly the class of bug that made "Triangulate All ▸ BA" look
            // like a no-op — never let the two silently disagree.
            var sk = getSkeletonFor(planeInstance);
            if (sk) sk.clearTriangulation();
            syncPlanes3D();   // drops the now-invalid plane from the 3D scene too
            refreshPlanePanel();
        },
        onPlaneSelectionChanged: function (planeInstance) {
            var statusEl = document.getElementById('statusSelection');
            if (statusEl && planeInstance) {
                var sk = getSkeletonFor(planeInstance);
                statusEl.textContent = 'Selection: plane ' +
                    (sk ? sk.name : '?') + ' / ' + planeInstance.viewName;
            } else if (statusEl && planeState.active) {
                statusEl.textContent = 'Selection: none';
            }
            refreshPlanePanel();
        },
    };
}

// ============================================
// Overlay rendering
// ============================================

const PLANE_LABEL_SIZE = 11;
const NULLED_COLOR = '#777777';
/** Alpha for a filled polygon — enough to read the plane, not enough to hide the video under it. */
const PLANE_FILL_ALPHA = 0.28;

/**
 * Draw every plane placement on `view`'s overlay canvas.
 *
 * Called from `drawAllOverlays` AFTER `drawFrameOverlays`, which begins with a
 * `clearRect` — drawing before it would be wiped. Placements are drawn in
 * every mode, not just Defining Plane Mode: they are scene geometry the user
 * annotated, and hiding them outside the mode would make them look lost. Only
 * the SELECTION and HOVER decorations are mode-gated, since those advertise an
 * interaction that only exists inside the mode.
 *
 * @param {{name:string, overlayCtx:CanvasRenderingContext2D,
 *          overlayCanvas:HTMLCanvasElement, videoWidth:number,
 *          videoHeight:number}} view
 */
export function drawPlaneOverlays(view) {
    if (!view || !view.overlayCtx || !view.overlayCanvas) return;
    var placements = getPlacements(view.name);
    if (!placements.length) return;

    var videoW = view.videoWidth || view.overlayCanvas.width;
    var videoH = view.videoHeight || view.overlayCanvas.height;
    if (!videoW || !videoH) return;

    var ctx = view.overlayCtx;
    var tf = makeVideoToCanvasTransform(
        videoW, videoH, view.overlayCanvas.width, view.overlayCanvas.height
    );

    var selected = (planeState.active && interactionManager)
        ? interactionManager.selectedPlane : null;
    var hovered = (planeState.active && interactionManager)
        ? interactionManager.hoveredPlaneNode : null;

    ctx.save();
    for (var i = 0; i < placements.length; i++) {
        drawOnePlacement(ctx, placements[i], tf, selected, hovered, view.name);
    }
    ctx.restore();
}

function drawOnePlacement(ctx, placement, tf, selected, hovered, viewName) {
    var sk = getSkeletonFor(placement);
    if (!sk) return;
    var edgeColor = sk.color || '#4dd0e1';
    var isSelected = placement === selected;
    var radius = planeState.nodeSize;
    var lineWidth = planeState.edgeWidth;

    // Polygon fill goes first — under the edges and nodes, so toggling it on
    // never obscures the thing you are positioning.
    if (sk.filled) fillPolygon(ctx, sk, placement, tf, edgeColor);

    // Edges next so nodes sit on top. A selected plane draws a wider,
    // semi-transparent halo under its edges.
    if (isSelected) {
        ctx.lineWidth = lineWidth + 5;
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        strokeEdges(ctx, sk, placement, tf);
    }
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = edgeColor;
    strokeEdges(ctx, sk, placement, tf);

    // Nodes + labels.
    ctx.font = PLANE_LABEL_SIZE + 'px sans-serif';
    ctx.textBaseline = 'middle';
    for (var n = 0; n < placement.numNodes; n++) {
        if (!placement.hasPoint(n)) continue;
        var p = tf(placement.getX(n), placement.getY(n));
        var nulled = placement.isNodeNulled(n);
        var nodeColor = nulled ? NULLED_COLOR : sk.getNodeColor(n);
        var isHovered = !!(hovered && hovered.viewName === viewName &&
            hovered.planeId === placement.id && hovered.nodeIdx === n);

        if (isHovered) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius + 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        if (nulled) {
            // Hollow = excluded from the later solve, matching how a nulled
            // pose node reads.
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = nodeColor;
            ctx.stroke();
        } else {
            ctx.fillStyle = nodeColor;
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';
            ctx.stroke();
        }

        var label = sk.nodes[n];
        if (label) {
            var lx = p.x + radius + 3;
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.strokeText(label, lx, p.y);
            ctx.fillStyle = nodeColor;
            ctx.fillText(label, lx, p.y);
        }
    }

    // Plane name at the placement's centroid, so overlapping placements of
    // different planes stay tellable apart.
    var c = placement.centroid();
    if (c) {
        var cp = tf(c[0], c[1]);
        ctx.textAlign = 'center';
        ctx.font = 'bold ' + PLANE_LABEL_SIZE + 'px sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeText(sk.name, cp.x, cp.y);
        ctx.fillStyle = isSelected ? '#ffffff' : edgeColor;
        ctx.fillText(sk.name, cp.x, cp.y);
        ctx.textAlign = 'start';
    }
}

/**
 * Fill the plane's polygon. Vertex order comes from `planePolygonOrder`, which
 * follows the user's connections when they form a closed ring — index order
 * would draw a self-intersecting bowtie for any quad whose corners were not
 * added in ring order.
 *
 * Nulled nodes are still vertices here: toggling a corner off means "don't use
 * this observation in the solve", not "this corner isn't part of the plane",
 * and dropping it would distort the outline.
 */
function fillPolygon(ctx, sk, placement, tf, color) {
    var order = planePolygonOrder(sk);
    var pts = [];
    for (var i = 0; i < order.length; i++) {
        var k = order[i];
        if (placement.hasPoint(k)) pts.push(tf(placement.getX(k), placement.getY(k)));
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

function strokeEdges(ctx, sk, placement, tf) {
    for (var e = 0; e < sk.edges.length; e++) {
        var a = sk.edges[e][0], b = sk.edges[e][1];
        if (!placement.hasPoint(a) || !placement.hasPoint(b)) continue;
        var pa = tf(placement.getX(a), placement.getY(a));
        var pb = tf(placement.getX(b), placement.getY(b));
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

    var nameInput = document.getElementById('planeSkeletonName');
    if (nameInput) {
        nameInput.addEventListener('change', function () {
            var sk = getSelectedPlaneSkeleton();
            if (!sk) return;
            var newName = nameInput.value.trim();
            if (!newName) { nameInput.value = sk.name; return; }
            sk.name = newName;
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
        addNodeBtn.addEventListener('click', function () {
            var sk = getSelectedPlaneSkeleton() || createPlaneSkeleton();
            var name = nodeInput ? nodeInput.value.trim() : '';
            // Default to the next positional name so a 4-corner plane is four
            // clicks rather than four clicks plus four typed names.
            if (!name) name = 'p' + (sk.nodes.length + 1);
            if (sk.nodes.indexOf(name) >= 0) {
                setStatus('Node "' + name + '" already exists in this plane', 'warning');
                return;
            }
            sk.addNode(name);
            syncPlacementsToSkeleton(sk);
            if (nodeInput) nodeInput.value = '';
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

    var addEdgeBtn = document.getElementById('btnAddPlaneEdge');
    if (addEdgeBtn) {
        addEdgeBtn.addEventListener('click', function () {
            var sk = getSelectedPlaneSkeleton();
            if (!sk) { setStatus('No plane skeleton selected', 'warning'); return; }
            var srcEl = document.getElementById('planeEdgeSrcSelect');
            var dstEl = document.getElementById('planeEdgeDstSelect');
            var src = srcEl ? parseInt(srcEl.value, 10) : NaN;
            var dst = dstEl ? parseInt(dstEl.value, 10) : NaN;
            if (isNaN(src) || isNaN(dst)) {
                setStatus('Add at least two nodes first', 'warning');
                return;
            }
            if (!sk.addEdge(src, dst)) {
                setStatus('Cannot connect: duplicate or same node', 'warning');
                return;
            }
            refreshPlanePanel();
            redraw();
        });
    }

    var newSkBtn = document.getElementById('btnNewPlaneSkeleton');
    if (newSkBtn) {
        newSkBtn.addEventListener('click', function () {
            createPlaneSkeleton();
            refreshPlanePanel();
        });
    }

    // --- Shared action row: acts on the SELECTED plane skeleton ---
    var triBtn = document.getElementById('btnPlaneTriangulate');
    if (triBtn) {
        triBtn.innerHTML = ICON_TRIANGULATE + '<span>Triangulate</span>';
        triBtn.addEventListener('click', function () {
            var sk = getSelectedPlaneSkeleton();
            if (!sk) return;
            triangulatePlaneAndReport(sk);
        });
    }

    var fillBtn = document.getElementById('btnPlaneFill');
    if (fillBtn) {
        fillBtn.innerHTML = ICON_MESH + '<span>Fill</span>';
        fillBtn.addEventListener('click', function () {
            var sk = getSelectedPlaneSkeleton();
            if (!sk) return;
            if (sk.nodes.length < 3) {
                setStatus('A polygon needs 3+ nodes to fill', 'warning');
                return;
            }
            sk.filled = !sk.filled;
            syncPlanes3D();          // the 3D fill mirrors the 2D one
            refreshPlanePanel();
            redraw();
        });
    }

    var fitBtn = document.getElementById('btnPlaneFit');
    if (fitBtn) {
        fitBtn.innerHTML = ICON_FIT + '<span>Fit</span>';
        fitBtn.addEventListener('click', function () {
            var sk = getSelectedPlaneSkeleton();
            if (!sk) return;
            fitPlaneAndReport(sk);
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
