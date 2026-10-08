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
//   - The Define Plane panel — TWO sibling sections: the global Nodes pool,
//                      and Planes (the roster, plus the editor for whichever
//                      plane is selected: its name, its member nodes, its
//                      connections and the actions that run on it).
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
// The panel's SHAPE is that model made visible, which is why the pool is its
// own section rather than a nodes editor nested inside a plane editor:
//
//   1. Nodes            — the project-wide pool. Name / colour / pin / delete
//                         all act on the NODE, so they apply to every plane
//                         using it. No membership column: a node is not owned
//                         by a plane. `+ Node` mints a POOL node and touches no
//                         plane at all — it neither creates one nor joins one.
//   2. Planes           — the roster AND the editor, in that order: the list
//                         (also the drag source, and the only thing that
//                         SELECTS), `+ New Plane`, then the selected plane's
//                         name and three foldable parts — Nodes In This Plane
//                         (× removes the REFERENCE, never the node, and an
//                         "add an existing node" dropdown puts one in), Node
//                         Connections, and Actions (Triangulate / Fill / Fit /
//                         Set Origin / Set Angle Between Planes). Plane
//                         Appearance goes last, outside the per-plane part,
//                         because it styles every plane in the list.
//
// Those two were three: picking a plane and editing it were separate sections,
// so the reader had to hold a plane in their head while scrolling between the
// list that picks it and the controls that act on it. One section, one plane.
//
// `+ Add` is the headline affordance: picking a node another plane already uses
// is exactly how an intersection is built, and it must stay at least as cheap
// as the checkbox it replaced. It is also the ONLY way a node enters a plane —
// creating a node and putting one in a plane are deliberately two separate
// acts, because a node is not owned by a plane.
//
// SELECTING and RENAMING are still two controls, and they are now in two
// different registers rather than two stacked rows: the ROSTER selects (a row
// click, the one writer of `planeState.selectedPlaneId` besides `createPlane`)
// and the Name field below renames. Merging them into one text box made "type
// here" mean both "find" and "rename" depending on state; a `<select>` above
// the Name field merely made the reader tell two labelled rows apart.
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
} from '../pose/plane-data.js?v=8ffc51b185aa';
import { PIN_STATES } from '../pose/plane-nodes.js?v=8ffc51b185aa';
import { hasPoint3d, getPoint3d } from '../pose/pose-data.js?v=8ffc51b185aa';

/**
 * The three pin states, as icons.
 *
 * Traced from the three padlock SVGs supplied for this control (Lucide-style
 * 24px strokes; the files themselves were dropped in the gitignored `prompts/`
 * scratch folder, so the geometry below is the only copy that survives) and
 * inlined as strings, the way `ICON_TRIANGULATE` and friends already are: the
 * app is served as static files with no build step, so an `<img>` per row would
 * be three more requests and a flash of nothing on first paint, and
 * `currentColor` is what lets one icon take the state's colour. The C2PA
 * provenance metadata the exported files carried is dropped — 8KB of base64 per
 * icon, saying nothing this repo does not.
 *
 * All three share a padlock body so the column reads as one thing; what differs
 * is the shackle (closed / open) and, for `plane-locked`, the plane the lock
 * stands on.
 * @private
 */
export const ICON_PIN = (function () {
    var open = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">';
    var body = '<rect x="5" y="11" width="14" height="9" rx="2"/>' +
        '<circle cx="12" cy="15" r="1" fill="currentColor" stroke="none"/>' +
        '<path d="M12 16.2V17.6"/>';
    return {
        'none': open + body + '<path d="M8 11V7a4 4 0 0 1 7.5 -2.3"/></svg>',
        'locked': open + body + '<path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
        // A smaller lock, sitting on a plane.
        'plane-locked': open +
            '<path d="M3 18.5 L9 16 L21 16 L15 18.5 Z" stroke-width="1.4"/>' +
            '<rect x="8" y="9" width="8" height="6" rx="1.3"/>' +
            '<path d="M10 9V7a2 2 0 0 1 4 0v2"/>' +
            '<circle cx="12" cy="11.7" r="0.7" fill="currentColor" stroke="none"/></svg>',
    };
}());

/** The Pin column's explanation button. @private */
export const ICON_INFO =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 11.2v5"/>' +
    '<circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none"/></svg>';

import { state, interactionManager, viewport3d } from './app-state.js?v=8ffc51b185aa';
import { makeVideoToCanvasTransform } from './overlays.js?v=8ffc51b185aa';
import { persistSectionStates } from './section-state.js?v=8ffc51b185aa';
import { setInfoTip } from './info-tip.js?v=8ffc51b185aa';
import { showPlaneDialog } from './plane-dialog.js?v=8ffc51b185aa';
// The Visibility panel's `Planes` toggles. Read by `syncPlanes3D` here and by
// the 2D overlay, which is what keeps the two representations agreeing about
// what "planes are off" means.
import { planeVisibility } from './plane-visibility.js?v=8ffc51b185aa';
// Imported as well as re-exported below: `export { x } from` makes the name
// importable FROM here but does not bind it in this module's own scope, and
// `enterPlaneMode` / `exitPlaneMode` call this one directly.
import { applyPlaneModeToolbarLock } from './plane-toolbar-lock.js?v=8ffc51b185aa';
// Section 1 of the panel, the Nodes pool. Imported (not merely re-exported)
// because
// `refreshPlanePanel` and the setup wiring call these directly.
import {
    renderNodesTable, renderPinInfoButton, renderFrozenWarning,
    // Shared with the 3D corner drag below, which reports where a
    // plane-locked node was pulled back to.
    planeLockWhere,
} from './plane-nodes-panel.js?v=8ffc51b185aa';
// The ROSTER half of section 2 — the Planes table and the actions that run on
// the selected plane. Imported, not merely re-exported: the panel refresh below
// calls these directly.
import {
    renderActionRow, renderPlanesTable, renderOriginButton,
    // The three action-button glyphs: the one-time wiring below sets their
    // innerHTML, so the hub needs the strings as well as the renderers.
    ICON_TRIANGULATE, ICON_MESH, ICON_FIT,
} from './plane-list-panel.js?v=8ffc51b185aa';
// The EDITOR half of section 2, below the roster in the same <details>.
import { renderEditor } from './plane-editor-panel.js?v=8ffc51b185aa';
import { setStatus, markDirty } from '../import-export/save-load.js?v=8ffc51b185aa';
// The 3D Mesh Objects table lives in its own module and is purely additive —
// this import and the two calls below are the whole of its coupling to the
// plane panel. Circular (it imports `planeModel`/`refreshPlanePanel` from
// here), and safe for the same reason the cycles above are: call-time use.
import {
    setupMeshObjects, refreshMeshObjectsPanel, getSelectedMeshObject,
} from './mesh-objects.js?v=8ffc51b185aa';
// Circular (rendering.js imports `drawPlaneOverlays` from here, and
// triangulation.js imports rendering.js). Safe because every use below is
// inside a function body, so the binding is resolved at call time rather than
// at module evaluation.
import { drawAllOverlays } from './rendering.js?v=8ffc51b185aa';
import {
    triangulatePoints, reprojectPointCamera, cameraDepth,
    fitPlaneToPoints3d, projectPoints3dOntoPlane,
    fitPlaneConstrained, projectPoints3dOntoPlaneConstrained,
    mergeFrozenPoints3d, summarizePlaneTriangulation, planesInvalidatedByFit,
} from '../pose/triangulation.js?v=8ffc51b185aa';
// Circular (origin-definition imports `planeState` / `syncPlanes3D` back).
// Same rule as the rendering.js cycle above: call-time use only.
import {
    enterOriginMode, exitOriginMode, isOriginModeActive, attachOriginCallbacks,
    setupOriginDefinition, renderOriginResult, fittedPlanes,
} from './origin-definition.js?v=8ffc51b185aa';
// Circular (plane-angle.js imports `planeModel` / `refreshPlanePanel` /
// `showPlaneDialog` back). Same rule as the cycles above: call-time use only.
import {
    setupPlaneAngle, renderAngleButton, isAngleModalOpen, closeAngleModal,
} from './plane-angle.js?v=8ffc51b185aa';

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
    /**
     * @type {number|null} The pool node id the panel has SELECTED, ringed in
     * the 3D view. Transient — a way to find one corner among nine, cleared by
     * the next click anywhere else, so it is neither saved nor remembered.
     * Separate from `expandedNodes`: opening a node's coordinates is a request
     * to READ something, selecting it is a request to be SHOWN where it is.
     */
    selectedNodeId: null,
    /** @type {Set<number>} Plane ids whose placement list is expanded. */
    expanded: new Set(),
    /**
     * @type {Set<number>} Pool node ids whose coordinate panel is open. Not
     * persisted — which rows you left open is a property of looking at the
     * panel, not of the project, and restoring nine open nodes on load would
     * hand back the clutter the collapsed list exists to remove.
     */
    expandedNodes: new Set(),
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
export function planeImmutableMask(plane) {
    var pool = planePool();
    return plane.nodeIds.map(function (id) {
        var node = pool.getNode(id);
        return !!(node && node.immutable);
    });
}

/**
 * Names of a plane's LOCKED nodes, in plane order.
 *
 * `planeImmutableMask` answers the same question as a boolean array, which is
 * the shape the solvers want; this is the shape a MESSAGE wants. A user told
 * "2 pinned nodes were held" has to go hunting for which; told "w2, w3" they
 * do not.
 * @param {PlaneSkeleton} plane @returns {string[]}
 */
function planeLockedNodeNames(plane) {
    if (!plane) return [];
    var pool = planePool();
    var out = [];
    for (var i = 0; i < plane.nodeIds.length; i++) {
        var node = pool.getNode(plane.nodeIds[i]);
        if (node && node.immutable) out.push(node.name);
    }
    return out;
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

    // Every node Locked means there is nothing a solve could write, so refuse
    // before doing the work rather than reporting a success that moved nothing.
    // `lockedNodeNames` is carried on BOTH branches so the caller can name the
    // nodes instead of counting them — see `triangulatePlaneAndReport`.
    var lockedNames = planeLockedNodeNames(plane);
    if (lockedNames.length === plane.nodeIds.length) {
        return {
            ok: false,
            lockedNodeNames: lockedNames,
            reason: 'Every node of "' + plane.name + '" is Locked (' +
                lockedNames.join(', ') + '), so triangulation has nothing it is ' +
                'allowed to move. Unlock at least one in the Nodes table first.',
        };
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
    writePoints3dForPlane(plane, pool, points3d, {
        constrain: function (id, xyz) { return model.constrainPoint3dForNode(id, xyz); },
    });
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
        lockedNodeNames: lockedNames,
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
/**
 * Tell the user, unmissably, that a solve did not move their Locked nodes.
 *
 * The skip itself is old behaviour and correct — `setPoint3d` refusing a
 * locked write is the entire pinning mechanism. What was wrong was the
 * REPORTING: it appeared as a parenthetical inside a green success line
 * ("... (2 pinned, kept)"), which reads as a detail rather than as "the thing
 * you just asked for did not happen to these corners". That matters far more
 * now that `Set Angle Between Planes` locks nodes automatically, so a user can
 * arrive here holding locks they did not set by hand and would otherwise have
 * no idea why Triangulate appears to do nothing to part of the plane.
 *
 * @param {string} action - 'Triangulate' / 'Fit', for the message.
 * @param {PlaneSkeleton} plane @param {string[]} names
 * @private
 */
function showLockedNodesDialog(action, plane, names) {
    if (!names || !names.length) return;
    var many = names.length !== 1;
    showPlaneDialog({
        title: many ? 'Some nodes are Locked' : 'One node is Locked',
        message: names.length + ' node' + (many ? 's' : '') + ' of "' + plane.name +
            '" ' + (many ? 'are' : 'is') + ' Locked and ' + (many ? 'were' : 'was') +
            ' NOT moved by ' + action + ':\n\n    ' + names.join(', ') +
            '\n\nA Locked node\u2019s 3D position is frozen — nothing, including ' +
            action + ', may change it. The rest of the plane was solved normally.' +
            '\n\nTo let ' + action + ' move ' + (many ? 'them' : 'it') + ', set ' +
            (many ? 'them' : 'it') + ' to Plane-locked or unpinned in the Nodes ' +
            'table above, then run ' + action + ' again.',
    });
}

function triangulatePlaneAndReport(plane) {
    var res = triangulatePlane(plane);
    if (!res.ok) {
        // An all-Locked plane is refused, and the reason is a paragraph about
        // which nodes and what to do — too much for the status bar alone.
        if (res.lockedNodeNames && res.lockedNodeNames.length) {
            showLockedNodesDialog('Triangulate', plane, res.lockedNodeNames);
        }
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
    // Locked nodes were skipped. Said in a modal rather than only in the
    // status line — see `showLockedNodesDialog`.
    if (res.ok && res.lockedNodeNames && res.lockedNodeNames.length) {
        showLockedNodesDialog('Triangulate', plane, res.lockedNodeNames);
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

    // The fit is STORED FIRST, and the order is load-bearing. A plane-locked
    // corner of this plane is held by this plane too, so the hook below has to
    // see the plane the fit just declared — store it afterwards and the hook
    // projects onto the plane being REPLACED, which the fit then moves out from
    // under it, leaving the corner off the very plane it was just fitted to (13
    // mm, in `tests/e2e/plane-lock-holds.mjs` §4). Writing it first costs
    // nothing: `plan` is already computed, and `flattened` is on this plane by
    // construction.
    plane.planeFit = {
        centroid: plan.fit.centroid,
        normal: plan.fit.normal,
        rms: plan.fit.rms,
        nPoints: plan.fit.nPoints,
        constrained: !!plan.fit.constrained,
    };

    // The flattened points are on THIS plane by construction, so the hook is a
    // no-op for a node this plane alone holds — and not a no-op for one that
    // also belongs to another plane. Fitting "right wall" must not drag a
    // corner it shares with "Ground" off Ground; without the hook it did,
    // silently, because `planeImmutableMask` deliberately reports only `locked`
    // and so a plane-locked corner is one the fit is free to move.
    var written = writePoints3dForPlane(plane, pool, flattened, {
        constrain: function (id, xyz) { return model.constrainPoint3dForNode(id, xyz); },
    });

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
export function refreshTriangulationErrors(plane) {
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
        // NOTE deliberately no locked-node dialog here, unlike Triangulate.
        // Holding pinned nodes fixed is what a CONSTRAINED FIT is for — the
        // plane is solved to pass exactly through them, so they are honoured
        // rather than skipped, and `reportFit` already says how many were held.
        // A modal would nag about the feature working as designed.
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

// Moved to `ui/plane-dialog.js` — it touches no plane state, and four
// modules share it. Re-exported here so every existing importer and every
// test that reaches it through this path is unaffected.
export { showPlaneDialog } from './plane-dialog.js?v=8ffc51b185aa';

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

    // The Visibility panel's `Planes` section, forced all-on inside the mode.
    // The two flags go onto the VIEWPORT rather than being filtered out of the
    // payload below, because `_planes` is also what a drag, the selected-node
    // marker, the mesh-object highlight and the angle dialog's role outlines
    // resolve their ids against — dropping entries would break those instead
    // of hiding meshes.
    var vis = planeVisibility(planeState.active);
    viewport3d.showPlaneSurfaces = vis.planes3d;
    viewport3d.showPlaneNodes = vis.nodes3d;

    var model = planeModel();
    var pool = model.pool;
    var payload = [];
    for (var i = 0; i < model.planes.length; i++) {
        var plane = model.planes[i];
        if (!planeHasAny3d(plane)) continue;
        // Stored fit, else one derived from this plane's own solved corners.
        // Gating the drag on a STORED fit was the same mistake `usableFit`
        // fixed for Set Angle: pinning any of a plane's nodes clears its
        // `planeFit`, so a well-annotated plane could sit there with three
        // solved corners — a perfectly good surface to slide along — and refuse
        // to be touched in 3D.
        var usableFit3d = model.usableFitForPlane(plane);
        payload.push({
            id: plane.id,
            name: plane.name,
            color: plane.color,
            // The pool ids behind this plane's corners, parallel to
            // `nodeColors`. It is what lets the viewport resolve the SELECTED
            // node — a pool-wide id — against corners it draws per plane,
            // without a position ever crossing the boundary.
            nodeIds: plane.nodeIds.slice(),
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
            // Corners are draggable in 3D only once the plane HAS a fit — the
            // fit is what supplies the surface a corner is allowed to slide
            // along — but a derived one counts, so an un-Fit plane with three
            // solved corners is draggable too. Gated on the mode too, matching
            // 2D: outside Defining Plane Mode a plane is visible but inert in
            // both representations.
            // Set Origin Mode also turns dragging off — a corner must not move
            // out from under the click that is selecting it as the origin. The
            // Set Angle dialog turns it off for the neighbouring reason: it is
            // NOT modal, so the view under it stays orbitable, and a corner
            // dragged while it is open would move the geometry its readout and
            // its ghost were computed from. Look, don't touch.
            editable: planeState.active && !isOriginModeActive() &&
                !isAngleModalOpen() && !!usableFit3d,
            planeFit: usableFit3d,
            // Set Origin's node picker asks a DIFFERENT question — "has the
            // user declared this plane's frame?" — and it is pinned by
            // `fittedPlanes()`, which counts stored fits only. Kept a separate
            // flag so widening the drag surface above does not quietly widen
            // which nodes can become the project's origin.
            fitted: !!plane.planeFit,
            points3d: points3dForPlane(plane, pool),
        });
    }
    viewport3d.setPlanes(payload);
    syncMeshObject3D();
    // After `setPlanes`, always: the marker is resolved against the payload that
    // call keeps, so a rebuild that does not re-run this leaves the selected
    // node unmarked until the next click.
    syncSelectedNode3D();
}

/**
 * Light up the SELECTED 3D Mesh Object's member planes, or clear the highlight.
 *
 * Additive, and separated from the payload loop above so the plane drawing is
 * unchanged. Lives here rather than in `ui/mesh-objects.js` because this is the
 * function every plane mutation already calls — routing it through one place is
 * what keeps the highlight from lagging a node drag by a frame.
 *
 * Only IDS cross this boundary. The viewport resolves them against the plane
 * payload it was just handed, so the highlight is drawn from the same numbers
 * as the planes and cannot land anywhere else; passing derived geometry instead
 * is what previously drew the object adrift of its own cage, since that
 * geometry is built in the user's origin frame and this group is not.
 * @private
 */
function syncMeshObject3D() {
    if (!viewport3d || !viewport3d.setMeshMembership) return;
    var obj = getSelectedMeshObject();
    if (!obj) { viewport3d.setMeshMembership(null); return; }
    viewport3d.setMeshMembership({
        planeIds: obj.resolvePlaneIds(planeModel()),
    });
}

// ============================================
// Selecting a node
// ============================================

/**
 * Mark the SELECTED node in 3D, or clear the mark.
 *
 * The twin of `syncMeshObject3D`, and it passes an ID for the same reason:
 * the viewport resolves it against the plane payload it already holds, so the
 * marker is built from the exact numbers the corner was drawn from. A node in
 * no plane has nothing drawn to mark — the 3D view draws planes — and the
 * panel says so instead.
 * @private
 */
export function syncSelectedNode3D() {
    if (!viewport3d || !viewport3d.setSelectedPlaneNode) return;
    var id = planeState.selectedNodeId;
    viewport3d.setSelectedPlaneNode(id == null ? null : { nodeId: id });
}

/**
 * Select one node, or clear the selection.
 *
 * Deliberately does NOT rebuild the Nodes table. Selection is a class on rows
 * that already exist, and the click that sets it is very often the click that
 * is about to focus the name field in the same row — a rebuild would throw
 * that input away before the caret landed in it. Toggling the class in place
 * leaves every field, its value and its focus exactly where they were.
 *
 * @param {number|null} id - Pool node id, or null to clear.
 * @private
 */
function setSelectedNode(id) {
    if (planeState.selectedNodeId === id) return;
    planeState.selectedNodeId = id;
    applyNodeSelectionClass();
    syncSelectedNode3D();
}

/**
 * Put `plane-node-selected` on the selected node's rows and take it off the
 * rest. Covers BOTH of a node's rows — the identity row and the coordinate
 * panel under it — so an expanded node is highlighted as one block.
 * @private
 */
function applyNodeSelectionClass() {
    var rows = document.querySelectorAll('#planeNodesTable tbody tr[data-plane-node-id]');
    for (var i = 0; i < rows.length; i++) {
        var mine = planeState.selectedNodeId != null &&
            rows[i].getAttribute('data-plane-node-id') === String(planeState.selectedNodeId);
        rows[i].classList.toggle('plane-node-selected', mine);
    }
}

/**
 * The one listener that decides what is selected, on every click in the app.
 *
 * CAPTURE phase, on `document`, for two reasons. It has to run for clicks the
 * row's own controls stop propagating (the colour swatch, the pin icon and the
 * pin popover all call `stopPropagation`, and a click on one of those still
 * means "this node"); and it has to see clicks that land nowhere near the
 * panel — in the 3D view, on the canvas, on another section — because those
 * are what CLEAR the selection.
 *
 * Anything carrying `data-plane-node-id` selects that node, which is the
 * Nodes table's two rows and the per-node lines of a plane's triangulation
 * readout. Everything else clears. The early return in `setSelectedNode`
 * means a click with nothing selected costs one `closest` call.
 * @private
 */
function onDocumentClickForNodeSelection(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-plane-node-id]') : null;
    if (!el) { setSelectedNode(null); return; }
    var id = parseInt(el.getAttribute('data-plane-node-id'), 10);
    setSelectedNode(isNaN(id) ? null : id);
}

// ============================================
// Dragging a plane corner in the 3D viewport
// ============================================

/** @type {number|null} Node id we last refused to drag, so the reason is said once. */
var _refused3dNodeId = null;
/** @type {number|null} Node id whose 3D drag is being held to another plane. */
var _held3dNodeId = null;

/**
 * Move one corner of a plane, in 3D, to a point the viewport has already
 * constrained to that plane's surface. Runs on every pointer move of the drag.
 *
 * The 2D follows the 3D here, which is the reverse of every other edit path in
 * the app — and it is the only consistent choice: a corner that has been fitted
 * is DEFINED by the plane, so its views are just where that 3D point lands.
 * Written through `reprojectPointCamera` (which applies distortion), not
 * `Camera.project`, because annotations live in native distorted pixel space.
 *
 * A LOCKED node is refused here, once per drag attempt, with the reason in the
 * status bar. The viewport cannot filter it out on its own — its payload marks
 * draggability per PLANE, not per node — so this is where the pin is enforced.
 *
 * A PLANE-LOCKED node is not refused, it is HELD:
 * `constrainPoint3dForNode` gets the last word, so a node keeps satisfying
 * EVERY plane it belongs to even while it is dragged as a corner of one of
 * them. The viewport's own constraint is the plane under the cursor, which
 * knows nothing about the pin and is only one of the planes holding the
 * corner, so without this a shared corner could be pulled off the others by
 * dragging it here — and the pin's whole promise is that it cannot. A corner
 * held by two planes then slides along the line they meet in, and one held by
 * three cannot move at all; either way it stops tracking the pointer, which is
 * correct and is why `onPlaneNodeDragEnd3D` says so.
 *
 * `plane.planeFit` is deliberately NOT re-derived. Centroid + normal are what a
 * later step turns into the origin's translation + rotation; a corner nudge must
 * not move the frame it defines.
 *
 * @param {number} planeId
 * @param {number} nodeIdx - Index into the plane's own node order.
 * @param {number[]} xyz - already on this plane's (stored or derived) surface
 */
function onPlaneNodeDragged3D(planeId, nodeIdx, xyz) {
    var model = planeModel();
    var pool = model.pool;
    var plane = model.getPlane(planeId);
    // A derived fit counts, exactly as in the `syncPlanes3D` payload that
    // decided this corner was draggable in the first place — the two have to
    // ask the same question or the drag starts and then does nothing.
    if (!plane || !model.usableFitForPlane(plane)) return;
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

    var held = model.constrainPoint3dForNode(nodeId, xyz);
    _held3dNodeId = (held[0] !== xyz[0] || held[1] !== xyz[1] || held[2] !== xyz[2])
        ? nodeId : null;
    xyz = held;
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
    var wasHeld = _held3dNodeId;
    _held3dNodeId = null;
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
    // A plane-locked corner was projected back onto EVERY plane it belongs to
    // on every move, so it did not end up where the pointer left it — and the
    // plane being dragged is only one of the planes that pulled it. Saying "it
    // stays on the fitted plane" here would name the wrong geometry and hide
    // the reason the corner lagged the cursor.
    if (node && wasHeld === node.id) {
        var where = planeLockWhere(model.planeLockForNode(node.id));
        setStatus('Moved "' + node.name + '" — Plane-locked' +
            (where ? ' to ' + where : '') + ', so it was projected back there ' +
            'rather than following the pointer');
        return;
    }
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

// Moved to `ui/plane-toolbar-lock.js`. Re-exported so `ui/rendering.js`
// and the tests keep reaching it through this module's path.
export { applyPlaneModeToolbarLock } from './plane-toolbar-lock.js?v=8ffc51b185aa';

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
    // they created and forgot. The editor half of the Planes section carries
    // its own empty state, so the panel is not a dead end without it.
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
    // leaving without unwinding it would strand every button disabled. The Set
    // Angle dialog is the same story: it is opened from this panel and holds it
    // locked, and it edits plane geometry, so it must not outlive the mode.
    if (isOriginModeActive()) exitOriginMode();
    closeAngleModal();
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
    renderAngleButton();
    renderOriginResult();
    // Additive: the 3D Mesh Objects table derives everything it shows from the
    // planes above, so it re-renders whenever they do and never holds its own
    // copy of anything.
    refreshMeshObjectsPanel();
    // LAST, so it can override whatever the renders above decided. Everything
    // in this panel edits plane geometry, and the Set Angle dialog is reading
    // that geometry live — see the edit-lock note in `ui/plane-angle.js`.
    applyAngleModalLock();
}

/**
 * Disable the Define Plane panel's controls while the Set Angle dialog is open.
 *
 * Asked of `isAngleModalOpen()` on every panel render rather than toggled on
 * open and off again on close: a render that happens WHILE the dialog is up
 * (the dialog itself causes some) rebuilds these rows from scratch, and a
 * remembered lock would leak an enabled button through every one of them.
 * Unlocking needs no bookkeeping either — the renders above have just recomputed
 * each control's real disabled state, so simply not re-disabling it is correct.
 *
 * The dialog itself is in `document.body`, not in this panel, so its own Cancel
 * and Apply are out of reach of the selector. The `<body>` class does what
 * `disabled` cannot: dim the panel, and block the `<summary>` elements that fold
 * these sections (divs, not controls).
 * @private
 */
function applyAngleModalLock() {
    var on = isAngleModalOpen();
    document.body.classList.toggle('plane-angle-lock', on);
    if (!on) return;
    var panel = document.getElementById('planePanel');
    if (!panel) return;
    var controls = panel.querySelectorAll('button, select, input, textarea');
    for (var i = 0; i < controls.length; i++) controls[i].disabled = true;
}

export function makeDeleteButton(title, onClick) {
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

export function setEmptyState(tableId, emptyId, isEmpty) {
    var table = document.getElementById(tableId);
    var empty = document.getElementById(emptyId);
    if (table) table.style.display = isEmpty ? 'none' : '';
    if (empty) empty.style.display = isEmpty ? '' : 'none';
}

// --- Section 1: the global Nodes table -------------------------------------
//
// Moved to `ui/plane-nodes-panel.js`: the Nodes table, the padlock picker,
// the typed x/y/z editor and node deletion. `refreshPlanePanel` below still
// drives them, and they are not re-exported because nothing outside this
// module ever called them.

// --- Section 2: Planes, in two modules -------------------------------------
//
// One <details> in the markup, two modules here, split by what they render:
// `ui/plane-list-panel.js` draws the ROSTER (the table, the drag source, the
// Views fraction, the placements sub-row and the action row), and
// `ui/plane-editor-panel.js` draws the SELECTED plane below it (the name, the
// member list, the add-node picker, the edge pickers). `refreshPlanePanel`
// below drives both.

export function redraw() {
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
    // The third edit path into plane data, and the one `applyAngleModalLock`
    // cannot reach: a plane row is dragged onto a view, and a `<tr>` takes no
    // `disabled`. Placing a plane creates a placement, so it is an edit like
    // any other — see the edit-lock note in `ui/plane-angle.js`.
    if (isAngleModalOpen()) {
        setStatus('Planes cannot be placed while Set Angle Between Planes is ' +
            'open — close that dialog first', 'warning');
        return null;
    }
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

/** Why a 2D plane edit was refused. One string, said by both refusals. */
const ANGLE_LOCK_MESSAGE = 'Plane nodes are locked while Set Angle Between ' +
    'Planes is open — close that dialog to edit them';

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
        // The rest of the Set Angle edit lock's 2D half. `beginPlaneDrag`
        // covers the drag; this covers the right-click null toggle, which
        // reaches the model without going through it. Reports the reason
        // itself, as a refused drag does — once per click, so it cannot spam.
        isPlaneDataLocked: function () {
            if (!isAngleModalOpen()) return false;
            setStatus(ANGLE_LOCK_MESSAGE, 'warning');
            return true;
        },
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
    // The 2D half of the Set Angle edit lock (the 3D half is the `editable`
    // flag in `syncPlanes3D`). The dialog reads plane geometry to say what the
    // current angle is and to draw its ghost, so nothing may edit that geometry
    // while it is open. The click still SELECTS, as with a pinned node.
    if (isAngleModalOpen()) {
        setStatus(ANGLE_LOCK_MESSAGE, 'warning');
        return { allowed: false, indices: null };
    }
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

// Moved to `ui/plane-overlays.js`. Re-exported so `ui/rendering.js` and
// the tests keep reaching it through this module's path.
export { drawPlaneOverlays } from './plane-overlays.js?v=8ffc51b185aa';

// ============================================
// Wiring
// ============================================

/**
 * One-time wiring for the plane-mode banner, the Define Plane panel controls,
 * and the dock drop target. Called once from `pose/initialization.js`.
 */
// Which of this panel's sections the user left open. Browser-local display
// taste — the same class as the appearance sliders below, and deliberately NOT
// in the project: loading someone else's `.slp` must not refold your panel.
var PLANE_SECTIONS_KEY = 'planeSectionsOpen';

// Every collapsible section in the panel, majors and the sub-sections inside
// them. Restoring only the majors would half-solve it: Planes is by far the
// tallest section in the panel and most of that height is its four
// sub-sections.
//
// `originDangerDetails` is deliberately ABSENT. It ships collapsed because it
// holds the three actions that rewrite the calibration every downstream tool
// reads, and a Danger Zone that stays open because it was expanded once, weeks
// ago, in a different project, is exactly the state it is collapsed to avoid.
// It costs one click to reopen and that click is the point.
var PLANE_SECTION_IDS = [
    'planeNodesDetails',
    'planePlanesDetails',
    'planeMembersDetails',
    'planeEdgesDetails',
    'planeActionsDetails',
    'planeAppearanceDetails',
    'meshObjectsDetails',
    'originResultDetails',
];

// What each explanation in the panel says, keyed by the ⓘ button that shows
// it: one per major section's <summary>, plus the Planes table's Views column.
//
// These used to be `.plane-hint` paragraphs at the FOOT of each section's
// table. In a ~300px column that is a wall of prose between one table and the
// next, permanently occupying the space the tables need, and read once — after
// which it is scenery the user scrolls past forever. As an ⓘ beside the
// heading the same sentence costs 16px, sits where the question is asked
// (before the section, not after it) and is visible while the section is
// COLLAPSED, which is exactly when "what was this one?" comes up.
//
// Only the majors get one. A sub-section's own empty-state line is a better
// explanation than a paragraph, and the Danger Zone's warning belongs in the
// confirmation dialogs that actually fire, not in a tooltip nobody hovers.
var PLANE_SECTION_INFO = {
    planeViewsInfo:
        'The fraction of number of hand-annotated views out of all views.',
    planeNodesInfo:
        'Define nodes here, which can be then added into plane(s). Note that ' +
        'a node can be included in multiple planes (e.g. edges of walls). ' +
        'Name, color, and pin the nodes here. Nodes must be initialized here ' +
        'first. Nodes can be fit into planes, or their 3D coordinates can be ' +
        'edited manually',
    planeEdgesInfo:
        'Connections are optional, purely for visual representation',
    planePlanesInfo:
        'Place a plane into a video view by dragging and dropping the plane ' +
        'row into it.',
    meshObjectsInfo:
        'A 3D Mesh Object is a group of planes, with its shape defined by the ' +
        'connection of nodes. Mesh Object export to .stl and .glb files are ' +
        'supported',
};

/**
 * Give every major section's ⓘ its icon and its text.
 *
 * Called ONCE from `setupPlaneDefinition`, not from `refreshPlanePanel`: these
 * buttons are in the static markup and their text never changes, so re-running
 * it on every repaint would be work for nothing. (`renderPinInfoButton` is the
 * exception, because the Pinned column's icon lives in a table header the panel
 * rebuilds.)
 * @private
 */
function wireSectionInfoButtons() {
    Object.keys(PLANE_SECTION_INFO).forEach(function (id) {
        var btn = document.getElementById(id);
        if (!btn) return;
        btn.innerHTML = ICON_INFO;
        setInfoTip(btn, PLANE_SECTION_INFO[id]);
    });
}

export function setupPlaneDefinition() {
    var exitBtn = document.getElementById('planeModeExit');
    if (exitBtn) exitBtn.addEventListener('click', exitPlaneMode);

    // Before anything else populates the panel: this only assigns `open`, so it
    // is independent of content, but doing it once at setup (rather than in
    // `refreshPlanePanel`) is what keeps it from fighting the user — a restore
    // on every repaint would reopen a section the moment they collapsed it.
    persistSectionStates(PLANE_SECTION_IDS, PLANE_SECTIONS_KEY);
    wireSectionInfoButtons();

    // What selects a node, and what clears it. One listener for both, because
    // "clicked a node row" and "clicked anywhere else" are the same event seen
    // from two sides — wiring selection per row and clearing per surface would
    // leave every surface nobody remembered to wire holding a stale marker.
    document.addEventListener('click', onDocumentClickForNodeSelection, true);

    setupMeshObjects();

    var nameInput = document.getElementById('planeSkeletonName');
    if (nameInput) {
        // The one place a plane is RENAMED. `refreshPlanePanel` rebuilds the
        // Planes table and the section header from the model, so both follow.
        nameInput.addEventListener('change', function () {
            var plane = getSelectedPlane();
            if (!plane) return;
            // An <input> outruns `lockUI`, which only reaches buttons, and
            // this handler's refresh would re-enable the locked action row.
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
        // `+ Add` in the Planes section is what places it.
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
                    'project-wide. Put it in a plane with + Add in Planes.', 'warning');
                return;
            }
            var node = model.addNode(name);
            markDirty();
            if (nodeInput) nodeInput.value = '';
            setStatus('Created node "' + node.name + '" in the project pool — it is in ' +
                'no plane yet; add it to one with + Add in Planes');
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

    // --- + New Plane: the section's one create affordance ---
    // It sits directly under the roster, above the editor: a new plane is empty
    // and the next thing to do with it is name it and add nodes, which is what
    // everything below the button is for. `createPlane` SELECTS it, so the
    // refresh below opens it in the editor.
    //
    // No Set Origin Mode refusal here, unlike the rename field beside it: this
    // is a <button>, so `lockUI` disables it and the click never lands.
    var newPlaneBtn = document.getElementById('btnNewPlaneSkeleton');
    if (newPlaneBtn) {
        newPlaneBtn.addEventListener('click', function () {
            var made = createPlane();
            refreshPlanePanel();
            setStatus('Created plane "' + made.name +
                '" — name it and add nodes with + Add', 'success');
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
    setupPlaneAngle();

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
